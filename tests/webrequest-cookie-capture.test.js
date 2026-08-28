import { describe, it, expect, beforeEach } from 'vitest'
import {
  handleBeforeSendHeaders,
  handleHeadersReceived,
  handleRequestCompleted,
} from '../background/dnr-manager.js'
import { tabSessions } from '../background/session-manager.js'
import { getCookieStore } from '../lib/session-store.js'
import { AUTH_BRIDGE_HEADER } from '../lib/auth-transition-bridge.js'

// Regression: post-login redirect race. DNR strips navigation Set-Cookie from
// Chrome's shared jar, while webRequest captures it and rebuilds DNR for later
// isolated requests.

function details({ tabId, url, type, setCookie }) {
  return {
    tabId,
    url,
    type,
    responseHeaders: [{ name: 'Set-Cookie', value: setCookie }],
  }
}

beforeEach(() => {
  for (const k of Object.keys(tabSessions)) delete tabSessions[k]
  chrome.tabs.get.mockResolvedValue({ id: 1, url: 'https://github.com/session' })
  chrome.tabs.sendMessage.mockClear()
})

describe('handleHeadersReceived — cookie capture + DNR rebuild timing', () => {
  it('main_frame Set-Cookie is captured and DNR is rebuilt immediately after capture', async () => {
    tabSessions[20] = 'session_login'
    await chrome.storage.local.set({ profiles: [{ id: 'session_login', name: 'L', hue: 0 }] })
    chrome.declarativeNetRequest.updateSessionRules.mockClear()

    await handleHeadersReceived(details({
      tabId: 20,
      url: 'https://github.com/session',
      type: 'main_frame',
      setCookie: 'user_session=abc123; Path=/; HttpOnly; Secure',
    }))

    // Cookie captured into the session store.
    const store = await getCookieStore('session_login')
    expect(Object.values(store).some(e => e.name === 'user_session' && e.value === 'abc123')).toBe(true)

    // DNR rebuilt synchronously (immediate), and the rebuilt rules inject the cookie.
    expect(chrome.declarativeNetRequest.updateSessionRules).toHaveBeenCalled()
    const calls = chrome.declarativeNetRequest.updateSessionRules.mock.calls
    const { addRules } = calls[calls.length - 1][0]
    const cookieRule = addRules.find(r => r.action.requestHeaders?.some(
      h => h.header === 'Cookie' && h.operation === 'set' && /user_session=abc123/.test(h.value || '')
    ))
    expect(cookieRule).toBeDefined()
  })

  it('subresource Set-Cookie is captured and DNR is rebuilt immediately', async () => {
    tabSessions[21] = 'session_sub'
    await chrome.storage.local.set({ profiles: [{ id: 'session_sub', name: 'S', hue: 0 }] })
    chrome.declarativeNetRequest.updateSessionRules.mockClear()

    await handleHeadersReceived(details({
      tabId: 21,
      url: 'https://github.com/avatar.png',
      type: 'image',
      setCookie: 'tracker=1; Path=/',
    }))

    // Captured…
    const store = await getCookieStore('session_sub')
    expect(Object.values(store).some(e => e.name === 'tracker')).toBe(true)
    // …and DNR rebuilt immediately so a following navigation/request can use it.
    expect(chrome.declarativeNetRequest.updateSessionRules).toHaveBeenCalled()
  })

  it('stores a late response in the profile that owned the request', async () => {
    tabSessions[25] = 'session_before_switch'
    await chrome.storage.local.set({
      profiles: [
        { id: 'session_before_switch', name: 'Before', hue: 0 },
        { id: 'session_after_switch', name: 'After', hue: 0 },
      ],
      cookies_session_before_switch: {},
      cookies_session_after_switch: {},
    })

    handleBeforeSendHeaders({
      requestId: 'late-response',
      tabId: 25,
      frameId: 0,
      url: 'https://github.com/login',
      requestHeaders: [],
    })
    tabSessions[25] = 'session_after_switch'

    await handleHeadersReceived({
      ...details({
        tabId: 25,
        url: 'https://github.com/login',
        type: 'xmlhttprequest',
        setCookie: 'before=1; Path=/',
      }),
      requestId: 'late-response',
    })

    const before = await getCookieStore('session_before_switch')
    const after = await getCookieStore('session_after_switch')
    expect(Object.values(before).some((entry) => entry.name === 'before')).toBe(true)
    expect(Object.values(after).some((entry) => entry.name === 'before')).toBe(false)
  })

  it('ignores default/unassigned tabs', async () => {
    chrome.declarativeNetRequest.updateSessionRules.mockClear()
    await handleHeadersReceived(details({
      tabId: 22,
      url: 'https://github.com/',
      type: 'main_frame',
      setCookie: 'x=1',
    }))
    expect(chrome.declarativeNetRequest.updateSessionRules).not.toHaveBeenCalled()
  })

  it('signals bridge completion after Set-Cookie capture and DNR rebuild', async () => {
    tabSessions[23] = 'session_bridge'
    await chrome.storage.local.set({ profiles: [{ id: 'session_bridge', name: 'B', hue: 0 }] })

    handleBeforeSendHeaders({
      requestId: 'req-1',
      tabId: 23,
      frameId: 0,
      requestHeaders: [{ name: AUTH_BRIDGE_HEADER, value: 'bridge-1' }],
    })

    await handleHeadersReceived({
      ...details({
        tabId: 23,
        url: 'https://github.com/session',
        type: 'xmlhttprequest',
        setCookie: 'user_session=abc123; Path=/; HttpOnly; Secure',
      }),
      requestId: 'req-1',
    })

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      23,
      { action: 'bridgeCookieSyncDone', bridgeId: 'bridge-1', cookieStr: '', cookieEntries: [] },
      { frameId: 0 },
    )
  })

  it('signals bridge completion on request completion when no Set-Cookie was captured', async () => {
    tabSessions[24] = 'session_bridge_done'
    await chrome.storage.local.set({ profiles: [{ id: 'session_bridge_done', name: 'B', hue: 0 }] })

    handleBeforeSendHeaders({
      requestId: 'req-2',
      tabId: 24,
      frameId: 0,
      requestHeaders: [{ name: AUTH_BRIDGE_HEADER, value: 'bridge-2' }],
    })

    await handleRequestCompleted({ requestId: 'req-2' })

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      24,
      { action: 'bridgeCookieSyncDone', bridgeId: 'bridge-2' },
      { frameId: 0 },
    )
  })
})
