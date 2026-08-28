import { describe, it, expect, vi } from 'vitest'
import { webcrypto } from 'node:crypto'

const BOOTSTRAP_PRIVATE_KEY = {
  kty: 'EC',
  x: 'WBBJCNZvPlR1B70GaUW-FaFHRHVJs_8WU-7JZTSKKQo',
  y: '58WLqE1ehEMRRds74MJmoYMheCXxO3yTOkltWFl77sQ',
  crv: 'P-256',
  d: 'M_E5D7NFHmN1L1oFYm4dZ2u_iBYYXvzF7KkWsSS-eyI',
}

function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

async function makeBootstrapProof(sessionId, nonce, challenge) {
  const key = await webcrypto.subtle.importKey(
    'jwk',
    BOOTSTRAP_PRIVATE_KEY,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  const payload = JSON.stringify({ sessionId, bootstrapToken: nonce, challenge })
  const signature = await webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(payload),
  )
  return { bootstrapProof: toBase64(signature), bootstrapProofPayload: payload }
}

function dispatchInit(data) {
  window.dispatchEvent(new MessageEvent('message', {
    data: { source: 'ext-content', action: 'initNonce', ...data },
    source: window,
    origin: window.location.origin,
  }))
}

describe('page-api-proxy insecure-origin fallback', () => {
  it('fails closed when HTTP has no SubtleCrypto instead of exposing native storage', async () => {
    vi.resetModules()
    const nativeLocalStorage = window.localStorage
    const nativeSessionStorage = window.sessionStorage
    Object.defineProperty(window, 'crypto', {
      configurable: true,
      value: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) },
    })

    await import('../src/page-api-proxy.ts')

    expect(window.localStorage).not.toBe(nativeLocalStorage)
    expect(window.sessionStorage).not.toBe(nativeSessionStorage)
    expect(window.localStorage.getItem('shared')).toBeNull()
    expect(window.sessionStorage.getItem('shared')).toBeNull()
    expect(document.cookie).toBe('')
  })

  it('still initializes a legitimate profile on HTTP using the packaged verifier', async () => {
    vi.resetModules()
    Object.defineProperty(window, 'crypto', {
      configurable: true,
      value: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) },
    })
    const postSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    await import('../src/page-api-proxy.ts')
    const challenge = postSpy.mock.calls.find(([message]) => message?.action === 'requestBootstrap')?.[0]?.challenge
    expect(challenge).toMatch(/^[0-9a-f]{64}$/)

    dispatchInit({
      sessionId: 'http_profile',
      nonce: 'http_nonce',
      bootstrapProof: 'invalid',
      bootstrapProofPayload: JSON.stringify({ sessionId: 'http_profile', bootstrapToken: 'http_nonce', challenge }),
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(window.localStorage.getItem('before-valid-proof')).toBeNull()
    expect(document.cookie).toBe('')

    const authorization = await makeBootstrapProof('http_profile', 'http_nonce', challenge)
    dispatchInit({
      sessionId: 'http_profile',
      nonce: 'http_nonce',
      cookieStr: 'profile_cookie=profile_value',
      ...authorization,
    })
    await new Promise((resolve) => setTimeout(resolve, 25))

    window.localStorage.setItem('profile-key', 'profile-value')
    expect(window.localStorage.getItem('profile-key')).toBe('profile-value')
    expect(document.cookie).toContain('profile_cookie=profile_value')
    postSpy.mockRestore()
  })
})
