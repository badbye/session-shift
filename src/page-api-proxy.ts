// page-api-proxy.ts
// Runs synchronously in the MAIN world at document_start.
// Intercepts web APIs for session isolation.

(function () {
  // Content scripts must ask the background for the active profile
  // asynchronously. Default pages keep native APIs during that round trip;
  // isolated pages install empty, fail-closed views immediately when the
  // authenticated profile identity arrives, before exposing profile data.
  const nativeDocumentCookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  const nativeStorageDescriptors = {
    localStorage: Object.getOwnPropertyDescriptor(Window.prototype, 'localStorage'),
    sessionStorage: Object.getOwnPropertyDescriptor(Window.prototype, 'sessionStorage'),
  };
  const nativeStorageValues: Partial<Record<'localStorage' | 'sessionStorage', Storage>> = {};
  for (const kind of ['localStorage', 'sessionStorage'] as const) {
    try {
      nativeStorageValues[kind] = nativeStorageDescriptors[kind]?.get?.call(window) as Storage;
    } catch {
      // Opaque documents may not expose a native Storage object.
    }
  }
  const nativeIndexedDB = window.indexedDB;
  const nativeCookieStore = window.cookieStore;
  const nativeCaches = window.caches;

  // The initial profile identity must be authorized by the service worker. A
  // page can forge same-window postMessage events, so a content-script nonce
  // alone is not enough. This public key is the trust anchor for the private
  // signing key imported only by the extension service worker; accepting a key
  // supplied through postMessage would let page code replace the trust anchor.
  const hasBootstrapCrypto = typeof globalThis.crypto?.subtle?.importKey === 'function'
    && typeof globalThis.crypto?.subtle?.verify === 'function';
  // Capture every platform primitive used by the fallback before page code can
  // replace it. In particular, the bytes checked by the signature must not be
  // produced by a page-overridden TextEncoder/atob/JSON.parse.
  const TrustedUint8Array = globalThis.Uint8Array;
  const TrustedUint32Array = globalThis.Uint32Array;
  const trustedAtob = typeof globalThis.atob === 'function' ? globalThis.atob.bind(globalThis) : null;
  const trustedJsonParse = JSON.parse.bind(JSON);
  const trustedBigInt = globalThis.BigInt.bind(globalThis);
  const trustedCharCodeAt = String.prototype.charCodeAt;
  const trustedGetRandomValues = typeof globalThis.crypto?.getRandomValues === 'function'
    ? globalThis.crypto.getRandomValues.bind(globalThis.crypto)
    : null;

  // Some HTTP origins are not secure contexts and therefore do not expose
  // SubtleCrypto in the MAIN world. Keep the bootstrap trust decision
  // independent of page-controlled APIs by using this small, self-contained
  // P-256/SHA-256 verifier as a fallback. It verifies the raw WebCrypto
  // ECDSA signature format (r || s, 32 bytes each) emitted by the service
  // worker. The public point is fixed below; no key material is accepted from
  // postMessage.
  const P256_PRIME = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
  const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const P256_A = P256_PRIME - 3n;
  const P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
  const P256_G = {
    x: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
    y: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
  };
  const P256_PUBLIC_X = 'WBBJCNZvPlR1B70GaUW-FaFHRHVJs_8WU-7JZTSKKQo';
  const P256_PUBLIC_Y = '58WLqE1ehEMRRds74MJmoYMheCXxO3yTOkltWFl77sQ';
  type P256Point = { x: bigint; y: bigint } | null;

  function createBootstrapChallenge(): string {
    if (!trustedGetRandomValues) return '';
    const bytes = new TrustedUint8Array(32);
    try {
      trustedGetRandomValues(bytes);
    } catch {
      return '';
    }
    let result = '';
    for (const byte of bytes) result += byte.toString(16).padStart(2, '0');
    return result;
  }

  let expectedBootstrapChallenge = createBootstrapChallenge();
  let bootstrapChallengeConsumed = false;
  let bootstrapVerificationInFlight = false;

  function mod(value: bigint, modulus: bigint): bigint {
    const result = value % modulus;
    return result >= 0n ? result : result + modulus;
  }

  function inverse(value: bigint, modulus: bigint): bigint {
    let oldR = mod(value, modulus);
    let r = modulus;
    let oldS = 1n;
    let s = 0n;
    while (r !== 0n) {
      const quotient = oldR / r;
      [oldR, r] = [r, oldR - quotient * r];
      [oldS, s] = [s, oldS - quotient * s];
    }
    return oldR === 1n ? mod(oldS, modulus) : 0n;
  }

  function addPoints(left: P256Point, right: P256Point): P256Point {
    if (!left) return right;
    if (!right) return left;
    if (left.x === right.x) {
      if (left.y !== right.y || left.y === 0n) return null;
      const slope = mod((3n * left.x * left.x + P256_A) * inverse(2n * left.y, P256_PRIME), P256_PRIME);
      const x = mod(slope * slope - 2n * left.x, P256_PRIME);
      return { x, y: mod(slope * (left.x - x) - left.y, P256_PRIME) };
    }
    const slope = mod((right.y - left.y) * inverse(right.x - left.x, P256_PRIME), P256_PRIME);
    const x = mod(slope * slope - left.x - right.x, P256_PRIME);
    return { x, y: mod(slope * (left.x - x) - left.y, P256_PRIME) };
  }

  function multiplyPoint(scalar: bigint, point: P256Point): P256Point {
    let result: P256Point = null;
    let addend = point;
    let remaining = scalar;
    while (remaining > 0n && addend) {
      if (remaining & 1n) result = addPoints(result, addend);
      addend = addPoints(addend, addend);
      remaining >>= 1n;
    }
    return result;
  }

  function sha256(message: Uint8Array): Uint8Array {
    const roundConstants = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    const paddedLength = Math.ceil((message.length + 9) / 64) * 64;
    const padded = new TrustedUint8Array(paddedLength);
    padded.set(message);
    padded[message.length] = 0x80;
    const bitLength = trustedBigInt(message.length) * 8n;
    const highLength = Number((bitLength >> 32n) & 0xffffffffn);
    const lowLength = Number(bitLength & 0xffffffffn);
    padded[paddedLength - 8] = highLength >>> 24;
    padded[paddedLength - 7] = highLength >>> 16;
    padded[paddedLength - 6] = highLength >>> 8;
    padded[paddedLength - 5] = highLength;
    padded[paddedLength - 4] = lowLength >>> 24;
    padded[paddedLength - 3] = lowLength >>> 16;
    padded[paddedLength - 2] = lowLength >>> 8;
    padded[paddedLength - 1] = lowLength;

    let h0 = 0x6a09e667;
    let h1 = 0xbb67ae85;
    let h2 = 0x3c6ef372;
    let h3 = 0xa54ff53a;
    let h4 = 0x510e527f;
    let h5 = 0x9b05688c;
    let h6 = 0x1f83d9ab;
    let h7 = 0x5be0cd19;
    const rotateRight = (value: number, count: number) => (value >>> count) | (value << (32 - count));
    for (let offset = 0; offset < padded.length; offset += 64) {
      const words = new TrustedUint32Array(64);
      for (let i = 0; i < 16; i++) {
        const position = offset + i * 4;
        words[i] = ((padded[position] << 24)
          | (padded[position + 1] << 16)
          | (padded[position + 2] << 8)
          | padded[position + 3]) >>> 0;
      }
      for (let i = 16; i < 64; i++) {
        const s0 = rotateRight(words[i - 15], 7) ^ rotateRight(words[i - 15], 18) ^ (words[i - 15] >>> 3);
        const s1 = rotateRight(words[i - 2], 17) ^ rotateRight(words[i - 2], 19) ^ (words[i - 2] >>> 10);
        words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
      }
      let a = h0; let b = h1; let c = h2; let d = h3;
      let e = h4; let f = h5; let g = h6; let h = h7;
      for (let i = 0; i < 64; i++) {
        const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
        const choose = (e & f) ^ (~e & g);
        const temp1 = (h + s1 + choose + roundConstants[i] + words[i]) >>> 0;
        const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (s0 + majority) >>> 0;
        h = g; g = f; f = e; e = (d + temp1) >>> 0;
        d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }
    const digest = new Uint8Array(32);
    const output = [h0, h1, h2, h3, h4, h5, h6, h7];
    for (let i = 0; i < output.length; i++) {
      digest[i * 4] = output[i] >>> 24;
      digest[i * 4 + 1] = output[i] >>> 16;
      digest[i * 4 + 2] = output[i] >>> 8;
      digest[i * 4 + 3] = output[i];
    }
    return digest;
  }

  function base64UrlToBigInt(value: string): bigint {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
    if (!trustedAtob) throw new Error('base64 decoder unavailable');
    const bytes = trustedAtob(normalized);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) hex += trustedCharCodeAt.call(bytes, i).toString(16).padStart(2, '0');
    return trustedBigInt(`0x${hex}`);
  }

  function verifyP256EcdsaSha256(signature: Uint8Array, message: Uint8Array): boolean {
    if (signature.length !== 64) return false;
    const readBigInt = (start: number) => {
      let value = 0n;
      for (let i = start; i < start + 32; i++) value = (value << 8n) | trustedBigInt(signature[i]);
      return value;
    };
    const r = readBigInt(0);
    const s = readBigInt(32);
    if (r <= 0n || r >= P256_ORDER || s <= 0n || s >= P256_ORDER) return false;
    const publicPoint = TRUSTED_PUBLIC_POINT;
    if (mod(publicPoint.y * publicPoint.y - publicPoint.x * publicPoint.x * publicPoint.x
      + 3n * publicPoint.x - P256_B, P256_PRIME) !== 0n) return false;
    const inverseS = inverse(s, P256_ORDER);
    if (inverseS === 0n) return false;
    const hash = sha256(message);
    let digest = 0n;
    for (const byte of hash) digest = (digest << 8n) | BigInt(byte);
    const point = addPoints(
      multiplyPoint(mod(digest, P256_ORDER) * inverseS % P256_ORDER, P256_G),
      multiplyPoint(r * inverseS % P256_ORDER, publicPoint),
    );
    return point !== null && mod(point.x, P256_ORDER) === r;
  }

  const TRUSTED_PUBLIC_POINT = {
    x: base64UrlToBigInt(P256_PUBLIC_X),
    y: base64UrlToBigInt(P256_PUBLIC_Y),
  };

  const bootstrapVerifyKeyPromise: Promise<CryptoKey | null> = hasBootstrapCrypto
    ? globalThis.crypto.subtle.importKey(
      'jwk',
      {
        kty: 'EC',
        x: 'WBBJCNZvPlR1B70GaUW-FaFHRHVJs_8WU-7JZTSKKQo',
        y: '58WLqE1ehEMRRds74MJmoYMheCXxO3yTOkltWFl77sQ',
        crv: 'P-256',
      },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    ).catch(() => null)
    : Promise.resolve(null);

  function decodeBase64(value: string): Uint8Array {
    if (!trustedAtob) throw new Error('base64 decoder unavailable');
    const binary = trustedAtob(value);
    return TrustedUint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function encodeUtf8(value: string): Uint8Array {
    // TextEncoder is intentionally not used: it is page-controlled in MAIN on
    // insecure origins. This follows the UTF-8 encoding rules for scalar values
    // and emits U+FFFD for a lone surrogate, matching TextEncoder.
    const bytes: number[] = [];
    for (let index = 0; index < value.length; index++) {
      const first = value.charCodeAt(index);
      let codePoint = first;
      if (first >= 0xd800 && first <= 0xdbff && index + 1 < value.length) {
        const second = value.charCodeAt(index + 1);
        if (second >= 0xdc00 && second <= 0xdfff) {
          codePoint = 0x10000 + ((first - 0xd800) << 10) + second - 0xdc00;
          index++;
        }
      }
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) codePoint = 0xfffd;
      if (codePoint <= 0x7f) bytes.push(codePoint);
      else if (codePoint <= 0x7ff) bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
      else if (codePoint <= 0xffff) bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
      else bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
    return TrustedUint8Array.from(bytes);
  }

  async function verifyBootstrapAuthorization(
    sessionId: string,
    nonce: string,
    proof: string,
    proofPayload: string,
  ): Promise<boolean> {
    try {
      const signed = trustedJsonParse(proofPayload) as { sessionId?: string; bootstrapToken?: string; challenge?: string };
      if (signed.sessionId !== sessionId || signed.bootstrapToken !== nonce
        || signed.challenge !== expectedBootstrapChallenge) return false;
      if (!hasBootstrapCrypto) {
        return verifyP256EcdsaSha256(decodeBase64(proof), encodeUtf8(proofPayload));
      }
      const verifyKey = await bootstrapVerifyKeyPromise;
      if (!verifyKey) return false;
      return await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        verifyKey,
        decodeBase64(proof) as unknown as BufferSource,
        encodeUtf8(proofPayload) as unknown as BufferSource,
      );
    } catch {
      return false;
    }
  }

  function nextOpaqueId(): string | null {
    if (!trustedGetRandomValues) return null;
    const bytes = new TrustedUint8Array(16);
    try {
      trustedGetRandomValues(bytes);
    } catch {
      return null;
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function postBootstrapRequest(): void {
    const origin = window.location.origin;
    if (origin === 'null' || !expectedBootstrapChallenge) return;
    window.postMessage({
      source: 'page-api-proxy',
      action: 'requestBootstrap',
      challenge: expectedBootstrapChallenge,
    }, origin);
  }

  function emptyStorage(): Storage {
    const data = new Map<string, string>();
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, String(value)); },
      removeItem: (key: string) => { data.delete(key); },
      clear: () => { data.clear(); },
      key: (index: number) => Array.from(data.keys())[index] ?? null,
      get length() { return data.size; },
    } as Storage;
  }

  const blockedLocalStorage = emptyStorage();
  const blockedSessionStorage = emptyStorage();
  const blockedIndexedDB = {
    open: () => { throw new DOMException('SessionShift is still initializing', 'SecurityError'); },
    deleteDatabase: () => { throw new DOMException('SessionShift is still initializing', 'SecurityError'); },
  };
  const blockedCookieStore = {
    get: () => Promise.resolve(null),
    getAll: () => Promise.resolve([]),
    set: () => Promise.reject(new DOMException('SessionShift is still initializing', 'SecurityError')),
    delete: () => Promise.reject(new DOMException('SessionShift is still initializing', 'SecurityError')),
  };
  const blockedCaches = {
    open: () => Promise.reject(new DOMException('SessionShift is still initializing', 'SecurityError')),
    delete: () => Promise.resolve(false),
    has: () => Promise.resolve(false),
    keys: () => Promise.resolve([]),
    match: () => Promise.resolve(undefined),
    matchAll: () => Promise.resolve([]),
  };
  let activeProfileSessionId = '';
  let activeProfileNonce = '';
  let activeProfilePrefix = '';
  let rebindProfile: ((sessionId: string, nonce: string, cookieStr: string, cookieEntries: CookieViewEntry[]) => void) | null = null;

  function installFailClosedApis(): void {
    Object.defineProperty(window, 'localStorage', {
      configurable: true, enumerable: true, get: () => blockedLocalStorage,
    });
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true, enumerable: true, get: () => blockedSessionStorage,
    });
    Object.defineProperty(document, 'cookie', {
      configurable: true, enumerable: true, get: () => '', set: () => {},
    });
    if (nativeIndexedDB) {
      Object.defineProperty(window, 'indexedDB', {
        configurable: true, enumerable: true, value: blockedIndexedDB,
      });
    }
    if (nativeCookieStore) {
      Object.defineProperty(window, 'cookieStore', {
        configurable: true, enumerable: true, value: blockedCookieStore,
      });
    }
    if (nativeCaches) {
      Object.defineProperty(window, 'caches', {
        configurable: true, enumerable: true, value: blockedCaches,
      });
    }
  }

  // `crypto.subtle` is unavailable to a MAIN-world script on some insecure
  // HTTP origins. Never leave the native page APIs exposed in that case: DNR
  // still protects network cookies, while these synchronous APIs must fail
  // closed until a verifiable profile bootstrap is possible.
  if (!hasBootstrapCrypto) installFailClosedApis();
  void bootstrapVerifyKeyPromise.then((verifyKey) => {
    if (!verifyKey) installFailClosedApis();
  });

  // 1. Wait for sessionId and nonce from content.ts (ISOLATED world) via postMessage.
  // Using postMessage instead of DOM attributes avoids the brief window where
  // another MAIN-world extension script could read the nonce before deletion.
  window.addEventListener('message', async function onInitNonce(event: MessageEvent) {
    if (
      event.source !== window ||
      !event.data ||
      event.data.source !== 'ext-content' ||
      event.data.action !== 'initNonce' ||
      typeof event.data.sessionId !== 'string' ||
      event.data.sessionId === 'default' ||
      typeof event.data.nonce !== 'string' ||
      typeof event.data.bootstrapProof !== 'string' ||
      typeof event.data.bootstrapProofPayload !== 'string'
    ) {
      return;
    }
    if (bootstrapChallengeConsumed || bootstrapVerificationInFlight) return;
    bootstrapVerificationInFlight = true;
    if (!await verifyBootstrapAuthorization(
      event.data.sessionId,
      event.data.nonce,
      event.data.bootstrapProof,
      event.data.bootstrapProofPayload,
    )) {
      bootstrapVerificationInFlight = false;
      return;
    }
    bootstrapVerificationInFlight = false;
    bootstrapChallengeConsumed = true;
    const cookieEntries = Array.isArray(event.data.cookieEntries) ? event.data.cookieEntries : [];
    const cookieStr = typeof event.data.cookieStr === 'string' ? event.data.cookieStr : '';
    // Install the fail-closed views and replace them with profile-scoped
    // proxies only after the isolated identity arrives. A loaded document can
    // receive another authenticated identity after a manual profile switch;
    // update the existing proxy state instead of stacking a second set of
    // storage/event listeners over the first one.
    if (rebindProfile) {
      rebindProfile(event.data.sessionId, event.data.nonce, cookieStr, cookieEntries);
    } else {
      initialize(event.data.sessionId, event.data.nonce, cookieStr, cookieEntries);
    }
  });

  // A profile switch gets a fresh challenge so a previously observed proof
  // cannot be replayed to move this document back to an older profile.
  window.addEventListener('message', function onRotateBootstrap(event: MessageEvent) {
    if (
      event.source !== window ||
      !event.data ||
      event.data.source !== 'ext-content' ||
      event.data.action !== 'rotateBootstrap'
    ) return;
    expectedBootstrapChallenge = createBootstrapChallenge();
    bootstrapChallengeConsumed = false;
    bootstrapVerificationInFlight = false;
    postBootstrapRequest();
  });

  // The isolated content script installs its request listener before awaiting
  // the service worker response. This makes the first bootstrap deterministic
  // even when the MAIN-world script runs first at document_start.
  postBootstrapRequest();

  type CookieViewEntry = {
    name: string
    value: string
    domain?: string | null
    path?: string
    expires?: number | null
    secure?: boolean
    sameSite?: string | null
  };

  function initialize(
    sessionId: string,
    nonce: string,
    initialCookieStr = '',
    initialCookieEntries: CookieViewEntry[] = [],
  ) {
  // Do not install empty implementations while the profile lookup is pending:
  // a default-profile document must keep its native APIs throughout that
  // asynchronous round trip. Once the authenticated content script identifies
  // an isolated Profile, install the fail-closed layer before exposing any
  // Profile-scoped proxy. Network Cookie leakage is independently prevented by
  // the tab-scoped DNR rules during this transition.
  installFailClosedApis();
  // 2. Prefix for storage isolation
  let prefix = '__ext_' + sessionId + '_';
  let currentNonce = nonce;
  activeProfileSessionId = sessionId;
  activeProfileNonce = nonce;
  activeProfilePrefix = prefix;

  // Opaque jsdom documents used by the unit suite may expose no backing
  // Storage object. Real HTTP(S) pages always provide native storage; this
  // narrow fallback keeps the proxy's contract testable without changing the
  // production path.
  function getRealStorage(kind: 'localStorage' | 'sessionStorage'): Storage {
    try {
      const candidate = nativeStorageValues[kind];
      if (candidate && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function') {
        return candidate;
      }
    } catch {
      // Fall through to an isolated in-memory implementation.
    }
    const data = new Map<string, string>();
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, String(value)); },
      removeItem: (key: string) => { data.delete(key); },
      clear: () => { data.clear(); },
      key: (index: number) => Array.from(data.keys())[index] ?? null,
      get length() { return data.size; },
    } as Storage;
  }

  // 3. Storage proxy factory
  function makeStorageProxy(realStorage: Storage) {
    return {
      getItem(key: string) {
        return realStorage.getItem(prefix + key);
      },
      setItem(key: string, value: string) {
        realStorage.setItem(prefix + key, String(value));
      },
      removeItem(key: string) {
        realStorage.removeItem(prefix + key);
      },
      clear() {
        const keysToRemove: string[] = [];
        for (let i = 0; i < realStorage.length; i++) {
          const k = realStorage.key(i);
          if (k && k.startsWith(prefix)) keysToRemove.push(k);
        }
        keysToRemove.forEach(k => realStorage.removeItem(k));
      },
      key(index: number) {
        let cur = 0;
        for (let i = 0; i < realStorage.length; i++) {
          const k = realStorage.key(i);
          if (k && k.startsWith(prefix)) {
            if (cur === index) return k.substring(prefix.length);
            cur++;
          }
        }
        return null;
      },
      get length() {
        let n = 0;
        for (let i = 0; i < realStorage.length; i++) {
          const k = realStorage.key(i);
          if (k && k.startsWith(prefix)) n++;
        }
        return n;
      }
    };
  }

  // 4. Override window.localStorage and window.sessionStorage.
  // Build the proxies ONCE and cache them so identity holds
  // (`localStorage === localStorage`) and set their prototype so
  // `instanceof Storage` passes — some libraries assert both.
  // KNOWN LIMITATION: direct/bracket property access (`localStorage.token = x`)
  // is NOT proxied — these are plain method objects, not a real `Proxy`. Use
  // getItem/setItem. A Proxy rewrite was rejected (larger blast radius on a core
  // isolation path).
  const realLocalStorage = getRealStorage('localStorage');
  const realSessionStorage = getRealStorage('sessionStorage');
  const localStorageProxy = makeStorageProxy(realLocalStorage);
  const sessionStorageProxy = makeStorageProxy(realSessionStorage);
  if (typeof Storage !== 'undefined') {
    Object.setPrototypeOf(localStorageProxy, Storage.prototype);
    Object.setPrototypeOf(sessionStorageProxy, Storage.prototype);
  }

  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    enumerable: true,
    get: function () { return localStorageProxy; }
  });

  Object.defineProperty(window, 'sessionStorage', {
    configurable: true,
    enumerable: true,
    get: function () { return sessionStorageProxy; }
  });

  // 4b. Remap `storage` events: native cross-tab writes arrive with prefixed keys
  // and include OTHER sessions' writes. Strip our prefix + re-dispatch a synthetic
  // event; swallow events for other sessions or unprefixed keys. A re-entry
  // sentinel is mandatory — re-dispatching on `window` re-triggers this same
  // listener; without the guard the synthetic loops or gets swallowed by the
  // own-prefix filter.
  // Sentinel tag on our own re-dispatched events. A stable global symbol (not a
  // per-instance WeakSet) so the guard still recognizes the event if the proxy is
  // somehow installed twice — otherwise a second interceptor would see the
  // already-stripped key, judge it "unprefixed", and swallow it. Page-forged tags
  // carry only page-supplied data (no cross-session leak), so the tag is safe.
  const SYNTHETIC = Symbol.for('__ext_synthetic_storage_event');
  window.addEventListener('storage', function (e: StorageEvent) {
    if ((e as unknown as Record<symbol, unknown>)[SYNTHETIC]) return; // our synthetic → pass through
    // Intercept the raw event before page listeners see prefixed/foreign keys.
    e.stopImmediatePropagation();
    const key = e.key;
    // key === null is storage.clear(); always forward a cleaned clear event.
    if (key !== null && !key.startsWith(prefix)) return; // other session / unprefixed → swallow
    const strippedKey = key === null ? null : key.substring(prefix.length);
    const area = e.storageArea === realSessionStorage ? sessionStorageProxy : localStorageProxy;
    const synthetic = new StorageEvent('storage', {
      key: strippedKey,
      oldValue: e.oldValue,
      newValue: e.newValue,
      url: e.url,
    });
    (synthetic as unknown as Record<symbol, unknown>)[SYNTHETIC] = true;
    // storageArea identity: site code may check `e.storageArea === localStorage`.
    // Point it at the same singleton the getter returns. Some engines ignore the
    // constructor's storageArea, so pin it explicitly.
    try {
      Object.defineProperty(synthetic, 'storageArea', { configurable: true, value: area });
    } catch { /* read-only in some engines; constructor value stands */ }
    // Re-dispatch on a microtask, not synchronously inside this handler: a nested
    // dispatch while the raw event is still propagating (after
    // stopImmediatePropagation) is fragile. The microtask re-enters this listener
    // and is passed through by the sentinel guard above.
    queueMicrotask(() => window.dispatchEvent(synthetic));
  }, true);

  // 5. Override document.cookie
  // cookieMap is populated asynchronously once content.js delivers the bootstrap cookies.
  // Until then, reads return '' — this is safe because the DNR rule handles network cookies.
  const cookieMap = new Map<string, CookieViewEntry>();
  let cookiesReady = false;

  function serializeCookieMap(): string {
    return Array.from(cookieMap.values())
      .filter(isCookieVisible)
      .sort((left, right) => (right.path || '/').length - (left.path || '/').length)
      .map(entry => entry.name + '=' + entry.value)
      .join('; ');
  }

  function cookieEntryKey(name: string, path = '/', domain = window.location.hostname): string {
    return `${name}\0${domain.toLowerCase()}\0${path || '/'}`;
  }

  function cookieDomainMatchesHost(domainValue: string | null | undefined, hostValue = window.location.hostname): boolean {
    const domain = (domainValue || hostValue).toLowerCase();
    const host = hostValue.toLowerCase();
    return domain.startsWith('.')
      ? host === domain.slice(1) || host.endsWith(`.${domain.slice(1)}`)
      : host === domain;
  }

  function cookiePathMatchesPath(pathValue: string | null | undefined, pathname = window.location.pathname || '/'): boolean {
    const path = pathValue || '/';
    return pathname === path || pathname.startsWith(path.endsWith('/') ? path : `${path}/`);
  }

  function isCookieVisible(entry: CookieViewEntry): boolean {
    return (entry.expires == null || entry.expires > Date.now())
      && (!entry.secure || window.location.protocol === 'https:' || window.location.hostname === 'localhost')
      && cookieDomainMatchesHost(entry.domain)
      && cookiePathMatchesPath(entry.path);
  }

  function removeCookieEntries(name: string, path?: string, domain?: string): void {
    const currentHost = window.location.hostname.toLowerCase();
    for (const [key, entry] of cookieMap) {
      if (entry.name !== name || (path !== undefined && (entry.path || '/') !== path)) continue;
      const entryDomain = (entry.domain || currentHost).toLowerCase();
      const matchesDomain = domain !== undefined
        ? entryDomain.replace(/^\./, '') === domain.replace(/^\./, '').toLowerCase()
        : cookieDomainMatchesHost(entryDomain, currentHost);
      if (matchesDomain) cookieMap.delete(key);
    }
  }

  function replaceCookieMap(cookieStr: string, entries: CookieViewEntry[] = []): void {
    const next = new Map<string, CookieViewEntry>();
    for (const entry of entries) {
      if (!entry || typeof entry.name !== 'string' || typeof entry.value !== 'string') continue;
      const path = typeof entry.path === 'string' && entry.path.startsWith('/') ? entry.path : '/';
      next.set(cookieEntryKey(entry.name, path, entry.domain || undefined), { ...entry, path });
    }
    for (const pair of cookieStr ? cookieStr.split('; ') : []) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx !== -1) {
        const name = pair.substring(0, eqIdx);
        if (!next.has(cookieEntryKey(name, '/', window.location.hostname))) {
          next.set(cookieEntryKey(name, '/', window.location.hostname), {
            name, value: pair.substring(eqIdx + 1), path: '/', domain: window.location.hostname,
          });
        }
      }
    }
    cookieMap.clear();
    for (const [name, value] of next) cookieMap.set(name, value);
  }

  function mergeCookieEntries(entries: CookieViewEntry[]): void {
    for (const entry of entries) {
      if (!entry || typeof entry.name !== 'string' || typeof entry.value !== 'string') continue;
      const path = typeof entry.path === 'string' && entry.path.startsWith('/') ? entry.path : '/';
      cookieMap.set(cookieEntryKey(entry.name, path, entry.domain || undefined), { ...entry, path });
    }
  }

  // A legacy bridge response may contain only a Cookie header. It cannot carry
  // path/domain metadata, so update an existing uniquely identified entry and
  // only create a root entry when no scoped entry exists. Never replace the
  // whole map: doing so turns a request-path header into false root cookies.
  function mergeCookieHeader(cookieStr: string): void {
    for (const pair of cookieStr ? cookieStr.split('; ') : []) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) continue;
      const name = pair.substring(0, eqIdx);
      const value = pair.substring(eqIdx + 1);
      const candidates = Array.from(cookieMap.values()).filter((entry) =>
        entry.name === name && cookieDomainMatchesHost(entry.domain) && cookiePathMatchesPath(entry.path));
      if (candidates.length === 1) {
        const entry = candidates[0];
        cookieMap.set(cookieEntryKey(entry.name, entry.path || '/', entry.domain || undefined), {
          ...entry,
          value,
        });
      } else if (candidates.length === 0) {
        cookieMap.set(cookieEntryKey(name), {
          name,
          value,
          path: '/',
          domain: window.location.hostname,
        });
      }
    }
  }

  replaceCookieMap(initialCookieStr, initialCookieEntries);

  function isValidCookieName(n: string): boolean {
    return n.length > 0 && n.length <= 1024 && /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/.test(n);
  }

  function isValidCookieValue(v: string): boolean {
    return v.length <= 4096 && !/[\r\n\0]/.test(v);
  }

  // Keep the local page view aligned with the browser's cookie write rules for
  // the attributes that affect visibility here. Max-Age takes precedence over
  // Expires; null means a session cookie and 0 is the deletion sentinel.
  function cookieExpiry(parts: string[], now = Date.now()): number | null {
    const maxAgePart = parts.slice(1).find((part) => /^\s*max-age\s*=/i.test(part));
    if (maxAgePart) {
      const raw = maxAgePart.split('=').slice(1).join('=').trim();
      if (/^-?\d+$/.test(raw)) {
        const seconds = Number(raw);
        if (Number.isFinite(seconds)) return seconds <= 0 ? 0 : now + seconds * 1000;
      }
    }
    const expiresPart = parts.slice(1).find((part) => /^\s*expires\s*=/i.test(part));
    if (expiresPart) {
      const raw = expiresPart.split('=').slice(1).join('=').trim();
      const timestamp = Date.parse(raw);
      if (Number.isFinite(timestamp)) return timestamp;
    }
    return null;
  }

  function hasSecureAttribute(parts: string[]): boolean {
    return parts.slice(1).some((part) => /^\s*secure\s*$/i.test(part));
  }

  function isSecureWriteAllowed(): boolean {
    return window.location.protocol !== 'http:' || window.location.hostname === 'localhost';
  }

  // Single relay for updateCookie messages. Skips null-origin pages where
  // broadcasting to '*' would be unsafe. Background re-validates everything.
  const pendingCookieWriteResolvers = new Map<string, () => void>();
  const pendingCookieWritePromises = new Map<string, Promise<void>>();

  function settleCookieWrite(updateId: string): void {
    pendingCookieWriteResolvers.get(updateId)?.();
    pendingCookieWriteResolvers.delete(updateId);
    pendingCookieWritePromises.delete(updateId);
  }

  function postUpdateCookie(payload: Record<string, unknown>): void {
    const origin = window.location.origin;
    if (origin === 'null') return;
    const updateId = nextOpaqueId();
    if (!updateId) return;
    const promise = new Promise<void>((resolve) => {
      pendingCookieWriteResolvers.set(updateId, resolve);
    });
    pendingCookieWritePromises.set(updateId, promise);
    window.setTimeout(() => settleCookieWrite(updateId), 2000);
    window.postMessage({
      source: 'page-api-proxy',
      nonce: currentNonce,
      action: 'updateCookie',
      updateId,
      payload: { url: window.location.href, ...payload },
    }, origin);
  }

  function waitForCookieWrites(): Promise<void> {
    return Promise.all(Array.from(pendingCookieWritePromises.values())).then(() => undefined);
  }

  const AUTH_BRIDGE_HEADER = 'X-SessionShift-Bridge';
  const AUTH_BRIDGE_TIMEOUT_MS = 2000;
  const nativeFetch = window.fetch?.bind(window);
  const pendingAuthBridgeWaiters = new Map<string, () => void>();

  function resolveAuthBridge(bridgeId: string): void {
    const resolve = pendingAuthBridgeWaiters.get(bridgeId);
    if (!resolve) return;
    pendingAuthBridgeWaiters.delete(bridgeId);
    resolve();
  }

  function waitForAuthBridge(bridgeId: string): Promise<void> {
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        pendingAuthBridgeWaiters.delete(bridgeId);
        resolve();
      }, AUTH_BRIDGE_TIMEOUT_MS);
      pendingAuthBridgeWaiters.set(bridgeId, () => {
        window.clearTimeout(timer);
        resolve();
      });
      });
    }

  function buildBridgedRequest(input: RequestInfo | URL, init?: RequestInit): Request | null {
    const request = input instanceof Request
      ? new Request(input, init)
      : new Request(new URL(String(input), window.location.href).href, init);
    const url = new URL(request.url, window.location.href);
    if (
      url.origin !== window.location.origin ||
      (url.protocol !== 'https:' && url.protocol !== 'http:')
    ) {
      return null;
    }
    const headers = new Headers(request.headers);
    const bridgeId = nextOpaqueId();
    if (!bridgeId) return null;
    headers.set(AUTH_BRIDGE_HEADER, bridgeId);
    return new Request(request, { headers });
  }

  if (nativeFetch) {
    const fetchProxy = async function (input: RequestInfo | URL, init?: RequestInit) {
      if (pendingCookieWritePromises.size > 0) await waitForCookieWrites();
      const bridgedRequest = buildBridgedRequest(input, init);
      if (!bridgedRequest) return nativeFetch(input, init);

      const bridgeId = bridgedRequest.headers.get(AUTH_BRIDGE_HEADER);
      if (!bridgeId) return nativeFetch(bridgedRequest);

      const waitForBridge = waitForAuthBridge(bridgeId);
      try {
        const response = await nativeFetch(bridgedRequest);
        await waitForBridge;
        return response;
      } catch (error) {
        pendingAuthBridgeWaiters.delete(bridgeId);
        throw error;
      }
    };
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      enumerable: true,
      value: fetchProxy,
    });
  }

  // XHR is another common authentication path. Mark only state-changing XHRs
  // so the background can capture their Set-Cookie response while keeping
  // ordinary GET polling on the normal path. The final property callbacks are
  // delayed until the background has republished profile DNR rules, matching
  // fetch's post-response bridge contract for the usual onload/onreadystatechange
  // APIs.
  const NativeXhr = window.XMLHttpRequest;
  if (NativeXhr) {
    // Keep the native prototype untouched. Default-session documents never
    // install this wrapper, and UI profile resets reload the tab.
    const Xhr = class SessionShiftXMLHttpRequest extends NativeXhr {};
    Object.defineProperty(window, 'XMLHttpRequest', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: Xhr,
    });
    const xhrProto = Xhr.prototype;
    const nativeOpen = xhrProto.open;
    const nativeSend = xhrProto.send;
    const nativeAddEventListener = xhrProto.addEventListener as (
      this: XMLHttpRequest,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) => void;
    const nativeRemoveEventListener = xhrProto.removeEventListener as (
      this: XMLHttpRequest,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) => void;
    const xhrMeta = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
    const xhrBridgeWaiters = new WeakMap<XMLHttpRequest, Promise<void>>();
    const xhrListenerWrappers = new WeakMap<
      XMLHttpRequest,
      Map<string, Map<EventListenerOrEventListenerObject, EventListener>>
    >();

    function listenerCapture(options?: boolean | AddEventListenerOptions): boolean {
      return typeof options === 'boolean' ? options : Boolean(options?.capture);
    }

    function invokeXhrListener(
      target: XMLHttpRequest,
      listener: EventListenerOrEventListenerObject,
      event: Event,
    ): void {
      if (typeof listener === 'function') listener.call(target, event);
      else listener.handleEvent.call(target, event);
    }

    xhrProto.addEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ): void {
      if (!listener || (type.toLowerCase() !== 'load' && type.toLowerCase() !== 'readystatechange')) {
        nativeAddEventListener.call(this, type, listener as EventListenerOrEventListenerObject | null, options);
        return;
      }
      const registeredListener = listener;
      const key = `${type.toLowerCase()}\0${listenerCapture(options) ? '1' : '0'}`;
      const byListener = xhrListenerWrappers.get(this) ?? new Map();
      const existing = byListener.get(key)?.get(listener);
      if (existing) {
        nativeAddEventListener.call(this, type, existing, options);
        return;
      }
      const wrapped: EventListener = (event) => {
        const run = () => invokeXhrListener(this, registeredListener, event);
        const waiter = xhrBridgeWaiters.get(this);
        if (waiter && (type.toLowerCase() !== 'readystatechange' || this.readyState === Xhr.DONE)) {
          void waiter.then(run);
        } else {
          run();
        }
      };
      const listenersForKey = byListener.get(key) ?? new Map();
      listenersForKey.set(registeredListener, wrapped);
      byListener.set(key, listenersForKey);
      xhrListenerWrappers.set(this, byListener);
      nativeAddEventListener.call(this, type, wrapped, options);
    };

    xhrProto.removeEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ): void {
      if (!listener || (type.toLowerCase() !== 'load' && type.toLowerCase() !== 'readystatechange')) {
        nativeRemoveEventListener.call(this, type, listener as EventListenerOrEventListenerObject | null, options);
        return;
      }
      const key = `${type.toLowerCase()}\0${listenerCapture(options) ? '1' : '0'}`;
      const wrapped = xhrListenerWrappers.get(this)?.get(key)?.get(listener);
      nativeRemoveEventListener.call(this, type, wrapped ?? listener, options);
      if (wrapped) xhrListenerWrappers.get(this)?.get(key)?.delete(listener);
    };

    xhrProto.open = function (method: string, url: string | URL, ...rest: unknown[]) {
      xhrMeta.set(this, { method: method.toUpperCase(), url: String(url) });
      const isAsync = typeof rest[0] === 'boolean' ? rest[0] : true;
      const user = typeof rest[1] === 'string' ? rest[1] : undefined;
      const password = typeof rest[2] === 'string' ? rest[2] : undefined;
      return nativeOpen.call(this, method, url, isAsync, user, password);
    };

    xhrProto.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
      const meta = xhrMeta.get(this);
      if (!meta || meta.method === 'GET' || meta.method === 'HEAD' || meta.method === 'OPTIONS') {
        if (pendingCookieWritePromises.size === 0) return nativeSend.call(this, body);
        void waitForCookieWrites().then(() => nativeSend.call(this, body));
        return undefined;
      }

      let url: URL;
      try {
        url = new URL(meta.url, window.location.href);
      } catch {
        if (pendingCookieWritePromises.size === 0) return nativeSend.call(this, body);
        void waitForCookieWrites().then(() => nativeSend.call(this, body));
        return undefined;
      }
      if (url.origin !== window.location.origin
        || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
        if (pendingCookieWritePromises.size === 0) return nativeSend.call(this, body);
        void waitForCookieWrites().then(() => nativeSend.call(this, body));
        return undefined;
      }

      const bridgeId = nextOpaqueId();
      if (!bridgeId) return nativeSend.call(this, body);
      try {
        this.setRequestHeader(AUTH_BRIDGE_HEADER, bridgeId);
      } catch {
        return nativeSend.call(this, body);
      }

      const waitForBridge = waitForAuthBridge(bridgeId);
      xhrBridgeWaiters.set(this, waitForBridge);
      void waitForBridge.then(() => {
        if (xhrBridgeWaiters.get(this) === waitForBridge) xhrBridgeWaiters.delete(this);
      });
      const originalLoad = this.onload;
      if (typeof originalLoad === 'function') {
        this.onload = function (event: ProgressEvent<EventTarget>) {
          void waitForBridge.then(() => originalLoad.call(this, event));
        };
      }
      const originalReady = this.onreadystatechange;
      if (typeof originalReady === 'function') {
        this.onreadystatechange = function (event: Event) {
          if (this.readyState !== Xhr.DONE) {
            originalReady.call(this, event);
            return;
          }
          void waitForBridge.then(() => originalReady.call(this, event));
        };
      }
      if (pendingCookieWritePromises.size === 0) return nativeSend.call(this, body);
      void waitForCookieWrites().then(() => nativeSend.call(this, body));
      return undefined;
    };
  }

  const readyOrigin = window.location.origin;
  if (readyOrigin !== 'null') {
    window.postMessage({
      source: 'page-api-proxy',
      action: 'initReady',
      nonce: currentNonce,
    }, readyOrigin);
  }

  Object.defineProperty(document, 'cookie', {
    configurable: true,
    enumerable: true,
    get: function () {
      return serializeCookieMap();
    },
    set: function (val: string) {
      if (typeof val !== 'string') return;
      const parts = val.split(';');
      const kv = parts[0].trim();
      const eqIdx = kv.indexOf('=');
      if (eqIdx === -1) return;

      const name = kv.substring(0, eqIdx);
      const value = kv.substring(eqIdx + 1);

      if (!isValidCookieName(name) || !isValidCookieValue(value)) return;

      // Check for deletion via max-age=0 or negative max-age
      const lowerVal = val.toLowerCase();
      const maxAgeAttribute = parts.slice(1).find((part) => /^\s*max-age\s*=/i.test(part));
      const strictMaxAgeMatch = maxAgeAttribute?.match(/^\s*max-age\s*=\s*(-?\d+)\s*$/i);
      const expiresMatch = lowerVal.match(/(?:^|;)\s*expires\s*=\s*([^;]*)/);
      const expiresAt = expiresMatch ? Date.parse(expiresMatch[1].trim()) : NaN;
      const isDeleting = Boolean(
        (strictMaxAgeMatch && parseInt(strictMaxAgeMatch[1], 10) <= 0)
        || (Number.isFinite(expiresAt) && expiresAt <= Date.now()),
      );

      if (isDeleting) {
        const pathAttribute = parts.slice(1).find((part) => /^\s*path\s*=/i.test(part));
        const declaredPath = pathAttribute?.split('=').slice(1).join('=').trim();
        const currentPath = window.location.pathname || '/';
        const lastSlash = currentPath.lastIndexOf('/');
        const defaultPath = lastSlash <= 0 ? '/' : currentPath.slice(0, lastSlash);
        const deletionPath = declaredPath?.startsWith('/') ? declaredPath : defaultPath;
        const hostname = window.location.hostname.toLowerCase();
        for (const [key, entry] of cookieMap) {
          if (entry.name !== name || (entry.path || '/') !== deletionPath) continue;
          const domain = (entry.domain || hostname).toLowerCase();
          if (domain === hostname || (domain.startsWith('.')
            && (hostname === domain.slice(1) || hostname.endsWith(`.${domain.slice(1)}`)))) {
            cookieMap.delete(key);
          }
        }
        // Keep the legacy name field for compatibility, and carry the browser's
        // path-scoped deletion semantics separately.
        postUpdateCookie({
          deletedNames: [name],
          deletedNamePaths: { [name]: deletionPath },
        });
      } else {
        // Secure cookies set from ordinary HTTP pages are ignored by the
        // browser (localhost is the deliberate development exception). Do not
        // expose a page-only value while the background rejects the write.
        if (hasSecureAttribute(parts) && !isSecureWriteAllowed()) return;
        const sameSiteAttribute = parts.slice(1).find((part) => /^\s*samesite\s*=/i.test(part));
        const sameSiteValue = sameSiteAttribute?.split('=').slice(1).join('=').trim().toLowerCase();
        if (sameSiteValue === 'none' && !hasSecureAttribute(parts)) return;
        const pathAttribute = parts.slice(1).find((part) => /^\s*path\s*=/i.test(part));
        const declaredPath = pathAttribute?.split('=').slice(1).join('=').trim();
        const currentPath = window.location.pathname || '/';
        const lastSlash = currentPath.lastIndexOf('/');
        const defaultPath = lastSlash <= 0 ? '/' : currentPath.slice(0, lastSlash);
        const cookiePath = declaredPath?.startsWith('/') ? declaredPath : defaultPath;
        const expires = cookieExpiry(parts);
        if (expires === 0) cookieMap.delete(cookieEntryKey(name, cookiePath));
        else cookieMap.set(cookieEntryKey(name, cookiePath, window.location.hostname), {
          name, value, domain: window.location.hostname, path: cookiePath, expires,
        });
        // Forward the FULL string so Path/Max-Age/Expires survive. Background
        // host-pins the domain (ignores any page-supplied Domain=).
        postUpdateCookie({ setCookieStr: val });
      }
    }
  });

  // 5b. Proxy window.cookieStore (async Cookie Store API, secure-context only).
  // Reads resolve from the local cookieMap; writes/deletes route through the same
  // nonce-authenticated updateCookie path as document.cookie. Returns a cached
  // singleton so identity checks (===) hold.
  if (nativeCookieStore) {
    const cookieStoreProxy = {
      get(name?: unknown) {
        const n = typeof name === 'string'
          ? name
          : (name && typeof name === 'object' ? (name as { name?: string }).name : undefined);
        if (n !== undefined) {
          const visible = Array.from(cookieMap.values())
            .filter(isCookieVisible)
            .filter((entry) => entry.name === n)
            .sort((left, right) => (right.path || '/').length - (left.path || '/').length)[0];
          if (visible) return Promise.resolve({ name: n, value: visible.value });
        }
        return Promise.resolve(null);
      },
      getAll(_opts?: unknown) {
        const out: Array<{ name: string; value: string | undefined; path?: string }> = [];
        const options = typeof _opts === 'string'
          ? { name: _opts }
          : (_opts && typeof _opts === 'object' ? _opts as { name?: unknown } : {});
        const requestedName = typeof options.name === 'string' ? options.name : undefined;
        for (const entry of cookieMap.values()) {
          if (!isCookieVisible(entry)) continue;
          if (requestedName !== undefined && entry.name !== requestedName) continue;
          out.push({ name: entry.name, value: entry.value, path: entry.path });
        }
        return Promise.resolve(out);
      },
      set(name: unknown, value?: unknown) {
        let n: string | undefined;
        let v = '';
        let path: string | undefined;
        let expires: number | undefined;
        let secure: boolean | undefined;
        let sameSite: string | undefined;
        if (typeof name === 'string') {
          n = name;
          v = String(value ?? '');
        } else if (name && typeof name === 'object') {
          const opts = name as { name?: string; value?: unknown; path?: string; expires?: number; secure?: boolean; sameSite?: string };
          n = opts.name;
          v = String(opts.value ?? '');
          path = opts.path;
          expires = opts.expires;
          secure = opts.secure;
          sameSite = opts.sameSite;
        }
        if (n === undefined || !isValidCookieName(n) || !isValidCookieValue(v)
          || (expires !== undefined && !Number.isFinite(expires))
          || (secure !== undefined && typeof secure !== 'boolean')
          || (sameSite !== undefined && !['strict', 'lax', 'none'].includes(sameSite.toLowerCase()))) {
          return Promise.reject(new TypeError('Invalid cookie name or value'));
        }
        if (sameSite?.toLowerCase() === 'none' && secure !== true) {
          return Promise.reject(new TypeError('SameSite=None cookies require Secure'));
        }
        let cookieStr = `${n}=${v}`;
        if (path) cookieStr += `; Path=${path}`;
        if (expires !== undefined) cookieStr += `; Expires=${new Date(expires).toUTCString()}`;
        if (secure === true) cookieStr += '; Secure';
        if (sameSite !== undefined) cookieStr += `; SameSite=${sameSite.toLowerCase()}`;
        if (secure === true && !isSecureWriteAllowed()) return Promise.resolve();
        // Domain intentionally NOT forwarded — host-pinned in background.
        const cookiePath = path?.startsWith('/') ? path : '/';
        if (expires !== undefined && expires <= Date.now()) cookieMap.delete(cookieEntryKey(n, cookiePath));
        else cookieMap.set(cookieEntryKey(n, cookiePath, window.location.hostname), {
          name: n, value: v, domain: window.location.hostname, path: cookiePath, expires,
          secure: secure === true,
          sameSite: sameSite?.toLowerCase(),
        });
        postUpdateCookie({ setCookieStr: cookieStr });
        return Promise.resolve();
      },
      delete(name: unknown) {
        const opts = typeof name === 'string'
          ? { name }
          : (name && typeof name === 'object' ? name as { name?: string; domain?: string; path?: string } : {});
        if (typeof opts.name !== 'string') {
          return Promise.reject(new TypeError('cookieStore.delete requires a name'));
        }
        const deletePath = typeof opts.path === 'string' && opts.path.startsWith('/') ? opts.path : '/';
        removeCookieEntries(opts.name, deletePath, typeof opts.domain === 'string' ? opts.domain : undefined);
        postUpdateCookie({
          deleteTargets: [{ name: opts.name, domain: opts.domain, path: opts.path }],
        });
        return Promise.resolve();
      },
      // onchange is NOT supported: it could only observe page JS writes, never
      // server-set or DNR-injected cookie changes, so partial support misleads.
    };
    Object.defineProperty(window, 'cookieStore', {
      configurable: true,
      enumerable: true,
      get: function () { return cookieStoreProxy; },
    });
  }

  // 6. Request cookie bootstrap from content.js via nonce-authenticated postMessage.
  // Cookies are never stored in DOM attributes — content.js holds them and delivers on request.
  window.addEventListener('message', function onBootstrap(event: MessageEvent) {
    if (
      event.source !== window ||
      !event.data ||
      event.data.source !== 'ext-content' ||
      event.data.action !== 'bootstrapCookies' ||
        event.data.nonce !== currentNonce
    ) {
      return;
    }
    window.removeEventListener('message', onBootstrap);
    cookiesReady = true;
    replaceCookieMap(event.data.cookieStr || '', event.data.cookieEntries || initialCookieEntries);
  });

  // Request cookie bootstrap from content.js. content.js is async (awaits background),
  // so its listener may not be ready yet — retry with backoff until acknowledged.
  // Budget: 50 ms × 40 = 2 s, which covers cold service-worker starts (~1–2 s).
  let retries = 0;
  const MAX_RETRIES = 40;
  const RETRY_MS = 50;

  function sendCookieRequest() {
    if (cookiesReady) return;
    if (retries >= MAX_RETRIES) {
      console.warn('[page-api-proxy] cookie bootstrap timed out — document.cookie reads will return empty');
      return;
    }
    retries++;
    const _reqOrigin = window.location.origin;
    if (_reqOrigin === 'null') return; // null-origin pages can't safely receive cookie bootstrap
    window.postMessage({
      source: 'page-api-proxy',
      nonce: currentNonce,
      action: 'requestCookies'
    }, _reqOrigin);
    setTimeout(sendCookieRequest, RETRY_MS);
  }

  sendCookieRequest();

  window.addEventListener('message', function onBridgeDone(event: MessageEvent) {
    if (
      event.source !== window ||
      !event.data ||
      event.data.source !== 'ext-content' ||
      event.data.action !== 'bridgeCookieSyncDone' ||
      event.data.nonce !== currentNonce ||
      typeof event.data.bridgeId !== 'string'
    ) {
      return;
    }
    if (Array.isArray(event.data.cookieEntries)) {
      mergeCookieEntries(event.data.cookieEntries);
    } else if (typeof event.data.cookieStr === 'string') {
      mergeCookieHeader(event.data.cookieStr);
    }
    resolveAuthBridge(event.data.bridgeId);
  });

  window.addEventListener('message', function onCookieUpdateDone(event: MessageEvent) {
    if (
      event.source !== window ||
      !event.data ||
      event.data.source !== 'ext-content' ||
      event.data.action !== 'cookieUpdateDone' ||
      event.data.nonce !== currentNonce ||
      typeof event.data.updateId !== 'string'
    ) return;
    settleCookieWrite(event.data.updateId);
  });

  // 7. Proxy IndexedDB
  if (nativeIndexedDB) {
    // Keep the native IDBFactory untouched. The synchronous fail-closed object
    // is still installed while bootstrap is pending, so mutate neither that
    // object nor the browser-owned factory when the isolated proxy is ready.
    const indexedDBProxy = new Proxy(nativeIndexedDB, {
      get(target, property, receiver) {
        if (property === 'open') {
          return (name: string, version?: number) => target.open(prefix + name, version);
        }
        if (property === 'deleteDatabase') {
          return (name: string) => target.deleteDatabase(prefix + name);
        }
        if (property === 'databases' && typeof target.databases === 'function') {
          return async () => {
            const dbs = await target.databases();
            return dbs
              .filter((d: IDBDatabaseInfo) => typeof d.name === 'string' && d.name.startsWith(prefix))
              .map((d: IDBDatabaseInfo) => ({ ...d, name: (d.name as string).substring(prefix.length) }));
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.defineProperty(window, 'indexedDB', {
      configurable: true, enumerable: true, value: indexedDBProxy,
    });
  }

  // 8. Proxy Cache API
  if (nativeCaches) {
    const realCachesOpen = nativeCaches.open.bind(nativeCaches);
    const realCachesDelete = nativeCaches.delete.bind(nativeCaches);
    const realCachesHas = nativeCaches.has.bind(nativeCaches);
    const realCachesKeys = nativeCaches.keys.bind(nativeCaches);
    const cacheProxy = {
      open: (name: string) => realCachesOpen(prefix + name),
      delete: (name: string) => realCachesDelete(prefix + name),
      has: (name: string) => realCachesHas(prefix + name),
      keys: async () => {
        const keys = await realCachesKeys();
        return keys
          .filter((k: string) => k.startsWith(prefix))
          .map((k: string) => k.substring(prefix.length));
      },
    };
    // caches.match() searches ALL caches by default — restrict to this session's
    // prefixed caches so a match never resolves against another session's cache.
    const realCachesMatch = nativeCaches.match.bind(nativeCaches);
    Object.assign(cacheProxy, {
      match: async (request: RequestInfo | URL, options?: MultiCacheQueryOptions) => {
        if (options?.cacheName !== undefined) {
          // Honor an explicit cacheName by scoping it to this session.
          return realCachesMatch(request, { ...options, cacheName: prefix + options.cacheName });
        }
        const names = (await realCachesKeys()).filter((k: string) => k.startsWith(prefix));
        for (const name of names) {
          const cache = await realCachesOpen(name);
          const hit = await cache.match(request, options);
          if (hit) return hit;
        }
        return undefined;
      },
      matchAll: async (request?: RequestInfo, options?: MultiCacheQueryOptions) => {
        if (options?.cacheName !== undefined) {
          const cache = await realCachesOpen(prefix + options.cacheName);
          return cache.matchAll(request, options as CacheQueryOptions);
        }
        const names = (await realCachesKeys()).filter((k: string) => k.startsWith(prefix));
        const matches: Response[] = [];
        for (const name of names) {
          const cache = await realCachesOpen(name);
          matches.push(...await cache.matchAll(request, options as CacheQueryOptions));
        }
        return matches;
      },
    });
    Object.defineProperty(window, 'caches', {
      configurable: true, enumerable: true, value: cacheProxy,
    });
  }

  rebindProfile = (nextSessionId, nextNonce, nextCookieStr, nextCookieEntries) => {
    prefix = '__ext_' + nextSessionId + '_';
    currentNonce = nextNonce;
    activeProfileSessionId = nextSessionId;
    activeProfileNonce = nextNonce;
    activeProfilePrefix = prefix;
    replaceCookieMap(nextCookieStr, nextCookieEntries);
    cookiesReady = false;
    retries = 0;
    // Complete writes issued under the old profile so a new-profile fetch does
    // not wait for a stale relay that the background will intentionally reject.
    for (const resolve of pendingCookieWriteResolvers.values()) resolve();
    pendingCookieWriteResolvers.clear();
    pendingCookieWritePromises.clear();
    sendCookieRequest();
  };

  } // end initialize

})();
