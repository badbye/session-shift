// content.ts
// Runs in the ISOLATED world at document_start.
// 1. Requests the authoritative profile identity from the service worker.
// 2. Delivers cookie string to page-api-proxy.js via nonce-authenticated postMessage
// 3. Relays updateCookie messages from page-api-proxy.js to background.js

(async () => {
  let activeSessionId = 'default';
  let activeCookieStr = '';
  let activeCookieEntries: Array<{ name: string; value: string; domain?: string | null; path?: string; expires?: number | null; secure?: boolean; sameSite?: string | null }> = [];
  let activeNonce = '';
  let isolationBootstrapped = false;
  let pendingBootstrapAck: (() => void) | null = null;
  let bootstrapTransition = Promise.resolve();

  type BootstrapAuthorization = {
    bootstrapToken?: string
    bootstrapProof?: string
    bootstrapProofPayload?: string
  };

  function responseAuthorization(response: BootstrapAuthorization | null | undefined): BootstrapAuthorization | undefined {
    if (typeof response?.bootstrapToken !== 'string'
      || typeof response.bootstrapProof !== 'string'
      || typeof response.bootstrapProofPayload !== 'string') return undefined;
    return response;
  }

  function postInitNonce(
    sessionId: string,
    nonce: string,
    cookieStr = activeCookieStr,
    cookieEntries: typeof activeCookieEntries = [],
    authorization?: BootstrapAuthorization,
  ): void {
    const initOrigin = window.location.origin;
    if (initOrigin === 'null') return;
    window.postMessage({
      source: 'ext-content',
      action: 'initNonce',
      sessionId,
      nonce,
      cookieStr,
      bootstrapProof: authorization?.bootstrapProof,
      bootstrapProofPayload: authorization?.bootstrapProofPayload,
      cookieEntries,
    }, initOrigin);
  }

  function ensureIsolationBootstrap(
    sessionId: string,
    cookieStr: string,
    cookieEntries: typeof activeCookieEntries = [],
    authorization?: BootstrapAuthorization,
  ): Promise<void> {
    const transition = bootstrapTransition.then(async () => {
      if (sessionId === 'default') {
        // Default documents never initialize MAIN-world isolation proxies.
        // The UI reloads after a profile reset, so the new document retains the
        // browser's native APIs without a destructive restore step.
        activeSessionId = 'default';
        activeCookieStr = '';
        activeCookieEntries = [];
        activeNonce = '';
        isolationBootstrapped = false;
        return;
      }
      if (!authorization) return;
      // A loaded document may be manually switched from one Profile to another
      // without a reload. Re-send the authenticated identity so the existing
      // MAIN-world proxy can atomically move its storage/cookie view as well.
      if (isolationBootstrapped && activeSessionId === sessionId) return;
      activeSessionId = sessionId;
      activeCookieStr = cookieStr;
      activeCookieEntries = cookieEntries;
      activeNonce = authorization.bootstrapToken!;
      isolationBootstrapped = true;
      postInitNonce(activeSessionId, activeNonce, activeCookieStr, activeCookieEntries, authorization);
    });
    bootstrapTransition = transition.catch(() => {});
    return transition;
  }

  let bootstrapRequestChain = Promise.resolve();
  window.addEventListener('message', (event: MessageEvent) => {
    if (
      event.source !== window ||
      !event.data ||
      event.data.source !== 'page-api-proxy' ||
      event.data.action !== 'requestBootstrap' ||
      typeof event.data.challenge !== 'string' ||
      event.data.challenge.length !== 64
    ) return;

    // Serialize requests so a stale service-worker response cannot overwrite
    // the profile selected for a newer challenge.
    bootstrapRequestChain = bootstrapRequestChain.then(async () => {
      const response = await chrome.runtime.sendMessage({
        action: 'getSessionForBootstrap',
        payload: { challenge: event.data.challenge },
      }) as {
        sessionId?: string
        cookieStr?: string
        cookieEntries?: typeof activeCookieEntries
        bootstrapToken?: string
        bootstrapProof?: string
        bootstrapProofPayload?: string
      } | null;
      if (!response) return;
      activeSessionId = response.sessionId || 'default';
      activeCookieStr = response.cookieStr || '';
      activeCookieEntries = response.cookieEntries || [];
      await ensureIsolationBootstrap(
        activeSessionId,
        activeCookieStr,
        activeCookieEntries,
        responseAuthorization(response),
      );
    }).catch((error: Error) => {
      console.debug('Failed to request session bootstrap:', error.message);
    });
  });

  // Listen for page-api-proxy.js requesting the cookie bootstrap.
  // It sends a requestCookies message; we reply with the actual cookie string.
  // This fires before any page JS runs because both scripts run at document_start.
  window.addEventListener('message', function onRequest(event: MessageEvent) {
    if (
      event.source !== window ||
      !event.data ||
      event.data.source !== 'page-api-proxy' ||
      event.data.action !== 'requestCookies' ||
      event.data.nonce !== activeNonce
    ) {
      return;
    }

    const targetOrigin = window.location.origin;
    if (targetOrigin === 'null') return;
    window.postMessage({
      source: 'ext-content',
      nonce: activeNonce,
      action: 'bootstrapCookies',
      cookieStr: activeCookieStr,
      cookieEntries: activeCookieEntries,
    }, targetOrigin);
  });

  window.addEventListener('message', (event: MessageEvent) => {
    if (
      event.source === window &&
      event.data &&
      event.data.source === 'page-api-proxy' &&
      event.data.action === 'initReady' &&
      event.data.nonce === activeNonce
    ) {
      pendingBootstrapAck?.();
      pendingBootstrapAck = null;
      return;
    }
    if (
      event.source !== window ||
      !event.data ||
      event.data.source !== 'page-api-proxy' ||
      event.data.nonce !== activeNonce ||
      event.data.action !== 'updateCookie'
    ) {
      return;
    }

    try {
      void chrome.runtime.sendMessage({
        action: 'updateCookie',
        payload: { ...event.data.payload, expectedProfileId: activeSessionId },
      }).then(() => {
        if (typeof event.data.updateId !== 'string') return;
        const targetOrigin = window.location.origin;
        if (targetOrigin === 'null') return;
        window.postMessage({
          source: 'ext-content',
          nonce: activeNonce,
          action: 'cookieUpdateDone',
          updateId: event.data.updateId,
        }, targetOrigin);
      }).catch(() => {});
    } catch (error) {
      console.debug('Failed to send updateCookie message:', (error as Error).message);
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return;

    if (
      message.action === 'bridgeCookieSyncDone' &&
      typeof message.bridgeId === 'string' &&
      activeNonce
    ) {
      const targetOrigin = window.location.origin;
      if (targetOrigin === 'null') return;
      window.postMessage({
        source: 'ext-content',
        nonce: activeNonce,
        action: 'bridgeCookieSyncDone',
        bridgeId: message.bridgeId,
        cookieStr: typeof message.cookieStr === 'string' ? message.cookieStr : undefined,
        cookieEntries: Array.isArray(message.cookieEntries) ? message.cookieEntries : undefined,
      }, targetOrigin);
      return;
    }

    if (message.action === 'sessionBootstrapChanged') {
      const needsBootstrap = !isolationBootstrapped;
      const bootstrapReady = needsBootstrap
        ? new Promise<void>((resolve) => {
          const timer = window.setTimeout(() => {
            pendingBootstrapAck = null;
            resolve();
          }, 500);
          pendingBootstrapAck = () => {
            window.clearTimeout(timer);
            resolve();
          };
        })
        : Promise.resolve();
      const targetOrigin = window.location.origin;
      if (targetOrigin !== 'null') {
        window.postMessage({ source: 'ext-content', action: 'rotateBootstrap' }, targetOrigin);
      }
      void bootstrapReady.then(() => sendResponse({ success: true }));
      return true;
    }
  });
})();
