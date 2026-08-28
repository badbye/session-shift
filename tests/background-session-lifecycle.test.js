import { describe, it, expect } from 'vitest'
import { webcrypto } from 'node:crypto'
import { handleMessage } from '../background.js'
import { handleRequestCompleted } from '../background/dnr-manager.js'
import { tabSessions } from '../background/session-manager.js'

const SENDER = { id: chrome.runtime.id }
const BOOTSTRAP_PUBLIC_KEY = {
  kty: 'EC',
  x: 'WBBJCNZvPlR1B70GaUW-FaFHRHVJs_8WU-7JZTSKKQo',
  y: '58WLqE1ehEMRRds74MJmoYMheCXxO3yTOkltWFl77sQ',
  crv: 'P-256',
}

function findCookieEntryByName(store, name) {
  return Object.values(store).find((entry) => entry?.name === name) ?? store[name]
}

function tabSender(tabId, url) {
  return { id: chrome.runtime.id, tab: { id: tabId, url } }
}

describe('getSessionForBootstrap', () => {
  it('returns default + empty cookieStr for unknown tab', async () => {
    const result = await handleMessage(
      { action: 'getSessionForBootstrap', payload: { tabId: 9999 } },
      SENDER
    )
    expect(result.sessionId).toBe('default')
    expect(result.cookieStr).toBe('')
  })

  it('returns sessionId + cookie string for an active session', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_boot1', name: 'Boot', hue: 212 }],
      'cookies_session_boot1': { tok: { value: 'abc', expires: null } },
    })
    await handleMessage(
      { action: 'setSession', payload: { tabId: 55, sessionId: 'session_boot1' } },
      SENDER
    )
    const result = await handleMessage(
      { action: 'getSessionForBootstrap', payload: { tabId: 55 } },
      tabSender(55, 'https://example.com/account')
    )
    expect(result.sessionId).toBe('session_boot1')
    expect(result.cookieStr).toContain('tok=abc')
  })

  it('returns a proof verifiable by the packaged MAIN-world public key', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_boot_crypto', name: 'Crypto Boot' }],
      'cookies_session_boot_crypto': {},
    })
    await handleMessage(
      { action: 'setSession', payload: { tabId: 56, sessionId: 'session_boot_crypto' } },
      SENDER,
    )

    const result = await handleMessage(
      { action: 'getSessionForBootstrap' },
      tabSender(56, 'https://example.com/'),
    )
    const verifyKey = await webcrypto.subtle.importKey(
      'jwk',
      BOOTSTRAP_PUBLIC_KEY,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )

    expect(await webcrypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifyKey,
      Uint8Array.from(Buffer.from(result.bootstrapProof, 'base64')),
      new TextEncoder().encode(result.bootstrapProofPayload),
    )).toBe(true)
  })
})

describe('refreshBadge', () => {
  it('returns success for valid tabId', async () => {
    const result = await handleMessage(
      { action: 'refreshBadge', payload: { tabId: 1 } },
      SENDER
    )
    expect(result.success).toBe(true)
  })

  it('returns error for non-numeric tabId', async () => {
    const result = await handleMessage(
      { action: 'refreshBadge', payload: { tabId: 'bad' } },
      SENDER
    )
    expect(result.error).toBeTruthy()
  })

  it('returns error when tabId is missing', async () => {
    const result = await handleMessage(
      { action: 'refreshBadge', payload: {} },
      SENDER
    )
    expect(result.error).toBeTruthy()
  })
})

describe('duplicateSession via handleMessage', () => {
  it('returns error for non-string sessionId', async () => {
    const result = await handleMessage(
      { action: 'duplicateSession', payload: { sessionId: 123 } },
      SENDER
    )
    expect(result.error).toBeTruthy()
  })

  it('creates duplicate via message handler', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_d1', name: 'Orig', hue: 158 }],
      'cookies_session_d1': { c: { value: '1', expires: null } },
    })
    const result = await handleMessage(
      { action: 'duplicateSession', payload: { sessionId: 'session_d1' } },
      SENDER
    )
    expect(result.success).toBe(true)
    expect(result.session.name).toBe('Orig (copy)')
  })
})

describe('createSessionTab — new profile must not leak the default jar cookie', () => {
  it('rejects unknown session ids before creating a tab', async () => {
    await chrome.storage.local.set({ profiles: [{ id: 'session_known', name: 'Known', hue: 0 }] })

    const result = await handleMessage(
      { action: 'createSessionTab', payload: { url: 'https://example.com/dashboard', sessionId: 'session_does_not_exist' } },
      SENDER
    )

    expect(result).toEqual({ error: 'unknown session' })
    expect(chrome.tabs.create).not.toHaveBeenCalled()
  })

  it('strips Cookie on the first navigation, then clears only the one-shot host strip', async () => {
    await chrome.storage.local.set({ profiles: [{ id: 'session_new1', name: 'New', hue: 0 }] })
    chrome.tabs.create.mockResolvedValue({ id: 401 })
    chrome.tabs.get.mockResolvedValue({ id: 401, url: 'https://example.com/dashboard' })
    chrome.declarativeNetRequest.updateSessionRules.mockClear()

    const result = await handleMessage(
      { action: 'createSessionTab', payload: { url: 'https://example.com/dashboard', sessionId: 'session_new1' } },
      SENDER
    )
    expect(result.success).toBe(true)

    // The very first DNR publish must strip Cookie on a main_frame/sub_frame
    // navigation to that exact host — otherwise Chrome attaches the default
    // jar's stale cookie and the brand-new profile looks logged in already.
    let calls = chrome.declarativeNetRequest.updateSessionRules.mock.calls
    let { addRules } = calls[calls.length - 1][0]
    const stripRule = addRules.find(r =>
      r.action.requestHeaders?.some(h => h.header === 'Cookie' && h.operation === 'remove') &&
      r.condition.resourceTypes?.includes('main_frame')
    )
    expect(stripRule).toBeDefined()

    // Once the navigation to that host completes, the one-shot host strip must
    // be cleared. The general tab-scoped remove rule remains: it protects later
    // navigations from the shared default jar when this Profile has no cookie
    // scope for the destination.
    await handleRequestCompleted({ requestId: 'nav-1', tabId: 401, type: 'main_frame' })
    calls = chrome.declarativeNetRequest.updateSessionRules.mock.calls
    ;({ addRules } = calls[calls.length - 1][0])
    const hostStripAfter = addRules.find(r =>
      r.action.requestHeaders?.some(h => h.header === 'Cookie' && h.operation === 'remove') &&
      r.condition.regexFilter?.includes('example\\.com') &&
      r.condition.resourceTypes?.includes('main_frame')
    )
    expect(hostStripAfter).toBeUndefined()

    delete tabSessions[401]
  })
})

describe('setSession — switching an open tab to a profile', () => {
  it('does not strip when switching back to default', async () => {
    chrome.tabs.get.mockResolvedValue({ id: 403, url: 'https://example.org/account' })
    chrome.declarativeNetRequest.updateSessionRules.mockClear()

    await handleMessage(
      { action: 'setSession', payload: { tabId: 403, sessionId: 'default' } },
      SENDER
    )

    const calls = chrome.declarativeNetRequest.updateSessionRules.mock.calls
    const { addRules } = calls[calls.length - 1][0]
    expect(addRules.length).toBe(0)

    delete tabSessions[403]
  })
})

describe('unknown action', () => {
  it('returns error for unknown action', async () => {
    const result = await handleMessage(
      { action: 'doesNotExist', payload: {} },
      SENDER
    )
    expect(result.error).toMatch(/unknown action/)
  })
})

describe('updateCookie trust boundary (H3)', () => {
  it('returns error when sender has no tab context', async () => {
    const result = await handleMessage(
      { action: 'updateCookie', payload: { cookieStr: 'a=1' } },
      SENDER
    )
    expect(result.error).toBe('no tab context')
  })

  it('merges new cookies without wiping existing ones', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_m1', name: 'M', hue: 0 }],
      'cookies_session_m1': { existing: { value: 'old', expires: null } },
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 200, sessionId: 'session_m1' } }, SENDER)
    await handleMessage(
      { action: 'updateCookie', payload: { cookieStr: 'newcookie=val', expectedProfileId: 'session_m1' } },
      tabSender(200, 'https://merge.com/page')
    )
    const stored = await chrome.storage.local.get(['cookies_session_m1'])
    expect(stored['cookies_session_m1'].existing.value).toBe('old')
    expect(findCookieEntryByName(stored['cookies_session_m1'], 'newcookie')?.value).toBe('val')
  })

  it('rejects a queued write from the previous Profile after a tab switch', async () => {
    await chrome.storage.local.set({
      profiles: [
        { id: 'session_old', name: 'Old', hue: 0 },
        { id: 'session_new', name: 'New', hue: 1 },
      ],
      cookies_session_old: {},
      cookies_session_new: {},
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 209, sessionId: 'session_old' } }, SENDER)
    await handleMessage({ action: 'setSession', payload: { tabId: 209, sessionId: 'session_new' } }, SENDER)
    const result = await handleMessage(
      { action: 'updateCookie', payload: { cookieStr: 'stale=1', expectedProfileId: 'session_old' } },
      tabSender(209, 'https://stale.example.com/'),
    )
    expect(result).toEqual({ success: false, reason: 'stale profile binding' })
    const stored = await chrome.storage.local.get(['cookies_session_old', 'cookies_session_new'])
    expect(findCookieEntryByName(stored.cookies_session_old, 'stale')).toBeUndefined()
    expect(findCookieEntryByName(stored.cookies_session_new, 'stale')).toBeUndefined()
  })

  it('empty cookieStr does not wipe existing cookies', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_w1', name: 'W', hue: 0 }],
      'cookies_session_w1': { precious: { value: 'keep', expires: null } },
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 201, sessionId: 'session_w1' } }, SENDER)
    await handleMessage(
      { action: 'updateCookie', payload: { cookieStr: '', expectedProfileId: 'session_w1' } },
      tabSender(201, 'https://wipe.com/page')
    )
    const stored = await chrome.storage.local.get(['cookies_session_w1'])
    expect(stored['cookies_session_w1'].precious.value).toBe('keep')
  })

  it('deletedNames removes the named cookie', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_del1', name: 'D', hue: 0 }],
      'cookies_session_del1': {
        gone:  { value: 'bye', expires: null },
        stays: { value: 'hi',  expires: null },
      },
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 202, sessionId: 'session_del1' } }, SENDER)
    await handleMessage(
      { action: 'updateCookie', payload: { cookieStr: '', deletedNames: ['gone'], expectedProfileId: 'session_del1' } },
      tabSender(202, 'https://del.com/page')
    )
    const stored = await chrome.storage.local.get(['cookies_session_del1'])
    expect(findCookieEntryByName(stored['cookies_session_del1'], 'gone')).toBeUndefined()
    expect(stored['cookies_session_del1'].stays.value).toBe('hi')
  })

  it('cannot overwrite a server-set httpOnly cookie via document.cookie path', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_hp1', name: 'HP', hue: 0 }],
      'cookies_session_hp1': { secret: { value: 'original', expires: null, httpOnly: true } },
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 203, sessionId: 'session_hp1' } }, SENDER)
    await handleMessage(
      { action: 'updateCookie', payload: { cookieStr: 'secret=hacked', expectedProfileId: 'session_hp1' } },
      tabSender(203, 'https://hp.com/page')
    )
    const stored = await chrome.storage.local.get(['cookies_session_hp1'])
    expect(findCookieEntryByName(stored['cookies_session_hp1'], 'secret')?.value).toBe('original')
  })

  it('allows a same-name page cookie when its path differs from an httpOnly cookie', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_hp_path', name: 'HP path', hue: 0 }],
      'cookies_session_hp_path': {
        'sid|hp-path.com|/': { name: 'sid', value: 'server', domain: 'hp-path.com', path: '/', expires: null, httpOnly: true },
      },
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 204, sessionId: 'session_hp_path' } }, SENDER)
    await handleMessage(
      { action: 'updateCookie', payload: { setCookieStr: 'sid=page; Path=/app', expectedProfileId: 'session_hp_path' } },
      tabSender(204, 'https://hp-path.com/app/page')
    )
    const stored = (await chrome.storage.local.get(['cookies_session_hp_path']))['cookies_session_hp_path']
    expect(stored['sid|hp-path.com|/']?.value).toBe('server')
    expect(stored['sid|hp-path.com|/app']?.value).toBe('page')
  })

  it('stores document.cookie writes under the current document host and default path', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_doc_host', name: 'Doc', hue: 0 }],
      'cookies_session_doc_host': {},
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 205, sessionId: 'session_doc_host' } }, SENDER)
    await handleMessage(
      { action: 'updateCookie', payload: { cookieStr: 'jsid=val', expectedProfileId: 'session_doc_host' } },
      tabSender(205, 'https://accounts.google.com/login/callback')
    )

    const stored = await chrome.storage.local.get(['cookies_session_doc_host'])
    expect(stored['cookies_session_doc_host']['jsid|accounts.google.com|/login']?.value).toBe('val')
    expect(stored['cookies_session_doc_host']['jsid|www.google.com|/']).toBeUndefined()
  })

  it('deletedNames only removes cookies matching the current document URL', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_doc_delete', name: 'Doc', hue: 0 }],
      'cookies_session_doc_delete': {
        'sid|accounts.google.com|/login': {
          name: 'sid',
          value: 'accounts',
          domain: 'accounts.google.com',
          path: '/login',
          expires: null,
        },
        'sid|www.google.com|/': {
          name: 'sid',
          value: 'www',
          domain: 'www.google.com',
          path: '/',
          expires: null,
        },
      },
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 206, sessionId: 'session_doc_delete' } }, SENDER)
    await handleMessage(
      { action: 'updateCookie', payload: { cookieStr: '', deletedNames: ['sid'], expectedProfileId: 'session_doc_delete' } },
      tabSender(206, 'https://accounts.google.com/login/callback')
    )

    const stored = await chrome.storage.local.get(['cookies_session_doc_delete'])
    expect(stored['cookies_session_doc_delete']['sid|accounts.google.com|/login']).toBeUndefined()
    expect(stored['cookies_session_doc_delete']['sid|www.google.com|/']?.value).toBe('www')
  })

  it('document.cookie deletion preserves a same-name cookie on another path', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_path_delete', name: 'Path', hue: 0 }],
      'cookies_session_path_delete': {
        'sid|accounts.google.com|/': {
          name: 'sid', value: 'root', domain: 'accounts.google.com', path: '/', expires: null,
        },
        'sid|accounts.google.com|/app': {
          name: 'sid', value: 'app', domain: 'accounts.google.com', path: '/app', expires: null,
        },
      },
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 207, sessionId: 'session_path_delete' } }, SENDER)
    await handleMessage(
      {
        action: 'updateCookie',
        payload: { setCookieStr: 'sid=; Max-Age=0; Path=/app', expectedProfileId: 'session_path_delete' },
      },
      tabSender(207, 'https://accounts.google.com/app/page')
    )

    const stored = await chrome.storage.local.get(['cookies_session_path_delete'])
    expect(stored['cookies_session_path_delete']['sid|accounts.google.com|/app']).toBeUndefined()
    expect(stored['cookies_session_path_delete']['sid|accounts.google.com|/']?.value).toBe('root')
  })
})

describe('updateCookie setCookieStr — attributes + injection guard (Phase 1)', () => {
  it('host-pins the domain and ignores a page-supplied Domain (no injection)', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_pin', name: 'Pin', hue: 0 }],
      'cookies_session_pin': {},
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 300, sessionId: 'session_pin' } }, SENDER)
    await handleMessage(
      { action: 'updateCookie', payload: { setCookieStr: 'sid=v; Domain=.evil.com; Path=/a; Max-Age=3600', expectedProfileId: 'session_pin' } },
      tabSender(300, 'https://app.example.com/a/page')
    )
    const store = (await chrome.storage.local.get(['cookies_session_pin']))['cookies_session_pin']
    // Domain host-pinned to the document host; page-supplied .evil.com NOT used.
    expect(store['sid|app.example.com|/a']?.value).toBe('v')
    expect(JSON.stringify(store)).not.toContain('evil')
    expect(store['sid|app.example.com|/a']?.expires).toBeGreaterThan(Date.now())
  })

  it('rejects a forged setCookieStr with a CRLF-injected value', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_crlf', name: 'C', hue: 0 }],
      'cookies_session_crlf': {},
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 301, sessionId: 'session_crlf' } }, SENDER)
    await handleMessage(
      { action: 'updateCookie', payload: { setCookieStr: 'sid=good\r\nevil=1', expectedProfileId: 'session_crlf' } },
      tabSender(301, 'https://app2.example.com/')
    )
    const store = (await chrome.storage.local.get(['cookies_session_crlf']))['cookies_session_crlf']
    expect(Object.keys(store).length).toBe(0)
  })

  it('cookieStore.delete structured target removes by name+path, not document URL', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_sd', name: 'SD', hue: 0 }],
      'cookies_session_sd': {
        'sid|app3.example.com|/admin': { name: 'sid', value: 'a', domain: 'app3.example.com', path: '/admin', expires: null },
        'sid|app3.example.com|/':      { name: 'sid', value: 'r', domain: 'app3.example.com', path: '/', expires: null },
      },
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 302, sessionId: 'session_sd' } }, SENDER)
    // Page is at /app but deletes the /admin-scoped cookie via structured target.
    await handleMessage(
      { action: 'updateCookie', payload: { deleteTargets: [{ name: 'sid', path: '/admin' }], expectedProfileId: 'session_sd' } },
      tabSender(302, 'https://app3.example.com/app')
    )
    const store = (await chrome.storage.local.get(['cookies_session_sd']))['cookies_session_sd']
    expect(store['sid|app3.example.com|/admin']).toBeUndefined()
    expect(store['sid|app3.example.com|/']?.value).toBe('r')
  })

  it('setCookieStr cannot overwrite a server-set httpOnly cookie', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_ho', name: 'HO', hue: 0 }],
      'cookies_session_ho': { 'secret|app4.example.com|/': { name: 'secret', value: 'orig', domain: 'app4.example.com', path: '/', expires: null, httpOnly: true } },
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 303, sessionId: 'session_ho' } }, SENDER)
    await handleMessage(
      { action: 'updateCookie', payload: { setCookieStr: 'secret=hacked', expectedProfileId: 'session_ho' } },
      tabSender(303, 'https://app4.example.com/')
    )
    const store = (await chrome.storage.local.get(['cookies_session_ho']))['cookies_session_ho']
    expect(store['secret|app4.example.com|/']?.value).toBe('orig')
  })
})

describe('updateCookie cache freshness', () => {
  it('rebuilds DNR from a page-written cookie instead of the old cache', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_cache_fresh', name: 'Fresh', hue: 0 }],
      cookies_session_cache_fresh: {
        old: { name: 'old', value: '1', domain: 'cache.example.com', path: '/', expires: null },
      },
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 304, sessionId: 'session_cache_fresh' } }, SENDER)
    chrome.declarativeNetRequest.updateSessionRules.mockClear()

    await handleMessage(
      { action: 'updateCookie', payload: { setCookieStr: 'fresh=2', expectedProfileId: 'session_cache_fresh' } },
      tabSender(304, 'https://cache.example.com/')
    )

    const [{ addRules }] = chrome.declarativeNetRequest.updateSessionRules.mock.calls.at(-1)
    expect(addRules.some((rule) => rule.action.requestHeaders?.[0]?.value?.includes('fresh=2'))).toBe(true)
  })
})

describe('getSessionForBootstrap httpOnly filtering (H1)', () => {
  it('excludes httpOnly cookies from the bootstrap cookie string', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_b2', name: 'B2', hue: 0 }],
      'cookies_session_b2': {
        visible: { value: 'show', expires: null, httpOnly: false },
        hidden:  { value: 'hide', expires: null, httpOnly: true },
      },
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 204, sessionId: 'session_b2' } }, SENDER)
    const result = await handleMessage(
      { action: 'getSessionForBootstrap', payload: { tabId: 204 } },
      tabSender(204, 'https://example.com/account')
    )
    expect(result.cookieStr).toContain('visible=show')
    expect(result.cookieStr).not.toContain('hidden=hide')
  })
})

describe('getSession', () => {
  it('returns default for tab with no session', async () => {
    const result = await handleMessage(
      { action: 'getSession', payload: { tabId: 8888 } },
      SENDER
    )
    expect(result.sessionId).toBe('default')
  })
})
