import { describe, it, expect } from 'vitest'
import {
  clearBridgeNavigationStrip,
  dnrRuleIdsForTab,
  prepareNavigationCookieStrip,
  releaseDnrRuleIdsForTab,
  updateDNRRulesForTab,
} from '../background/dnr-manager.js'
import { cookieKey } from '../lib/cookie-parser.js'

async function setupProfile({ sessionId, tabId, tabUrl, store = {} }) {
  await chrome.storage.local.set({
    profiles: [{ id: sessionId, name: 'Test', hue: 212 }],
    [`cookies_${sessionId}`]: store,
  })
  chrome.tabs.get.mockResolvedValue({ id: tabId, url: tabUrl })
}

describe('updateDNRRulesForTab', () => {
  it('does not publish a cancelled delayed preflight strip', async () => {
    chrome.declarativeNetRequest.updateSessionRules.mockClear()

    prepareNavigationCookieStrip(19, 'https://example.com/account')
    clearBridgeNavigationStrip(19)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(chrome.declarativeNetRequest.updateSessionRules).not.toHaveBeenCalled()
  })

  it('allocates disjoint rule ranges for colliding tab IDs', () => {
    const first = dnrRuleIdsForTab(100)
    const second = dnrRuleIdsForTab(1_000_100)
    expect(first.some((id) => second.includes(id))).toBe(false)
    releaseDnrRuleIdsForTab(100)
    releaseDnrRuleIdsForTab(1_000_100)
  })

  it('supports more than 22 isolated tabs without overlapping IDs', () => {
    const tabIds = Array.from({ length: 23 }, (_, index) => 10_000_000 + index)
    try {
      const ranges = tabIds.map((tabId) => dnrRuleIdsForTab(tabId))
      const allIds = ranges.flat()
      expect(new Set(allIds).size).toBe(allIds.length)
    } finally {
      for (const tabId of tabIds) releaseDnrRuleIdsForTab(tabId)
    }
  })

  it('base-strips subresource Cookie and Set-Cookie while navigation uses exact preflight rules', async () => {
    await setupProfile({
      sessionId: 'session_google',
      tabId: 10,
      tabUrl: 'https://www.google.com/',
    })

    await updateDNRRulesForTab(10, 'session_google')

    expect(chrome.declarativeNetRequest.updateSessionRules).toHaveBeenCalledTimes(1)
    const [{ addRules }] = chrome.declarativeNetRequest.updateSessionRules.mock.calls[0]
    // addRules[0] = request-side Cookie strip, tab-scoped for every resource.
    expect(addRules[0].action.requestHeaders[0]).toEqual({ header: 'Cookie', operation: 'remove' })
    expect(addRules[0].condition.requestDomains).toBeUndefined()
    expect(addRules[0].condition.urlFilter).toBeUndefined()
    expect(addRules[0].condition.excludedRequestDomains).toBeUndefined()
    expect(addRules[0].condition.resourceTypes).toContain('main_frame')
    expect(addRules[0].condition.resourceTypes).toContain('sub_frame')
    const responseRules = addRules.filter((rule) => rule.action.responseHeaders?.[0]?.header === 'set-cookie')
    expect(responseRules.length).toBe(1)
    const [strictResponseRule] = responseRules
    expect(strictResponseRule.condition.excludedRequestDomains).toBeUndefined()
    expect(strictResponseRule.condition.requestDomains).toBeUndefined()
    expect(strictResponseRule.condition.urlFilter).toBeUndefined()
    expect(strictResponseRule.condition.resourceTypes).toContain('main_frame')
    expect(strictResponseRule.condition.resourceTypes).toContain('sub_frame')
  })

  it('keeps the http profile base strip navigation-free too', async () => {
    await setupProfile({
      sessionId: 'session_http',
      tabId: 11,
      tabUrl: 'http://www.google.com/',
    })

    await updateDNRRulesForTab(11, 'session_http')

    const [{ addRules }] = chrome.declarativeNetRequest.updateSessionRules.mock.calls.at(-1)
    // The http scheme is still derived from the tab URL for cookie SET rules
    // (Secure exclusion); main-frame navigation is protected by exact preflight.
    const responseRules = addRules.filter((rule) => rule.action.responseHeaders?.[0]?.header === 'set-cookie')
    expect(addRules[0].condition.requestDomains).toBeUndefined()
    expect(addRules[0].condition.excludedRequestDomains).toBeUndefined()
    expect(responseRules.every((rule) => !rule.condition.excludedRequestDomains)).toBe(true)
    expect(addRules[0].condition.resourceTypes).toContain('main_frame')
    expect(responseRules.every((rule) => rule.condition.resourceTypes.includes('main_frame'))).toBe(true)
  })

  it('adds a tab-scoped signed startup carrier for every HTTP(S) main-frame navigation', async () => {
    await setupProfile({
      sessionId: 'session_startup',
      tabId: 101,
      tabUrl: 'http://example.test/app',
    })

    await updateDNRRulesForTab(101, 'session_startup')

    const [{ addRules }] = chrome.declarativeNetRequest.updateSessionRules.mock.calls.at(-1)
    const carrier = addRules.find((rule) => rule.action.redirect?.transform?.queryTransform)
    expect(carrier).toBeDefined()
    expect(carrier.condition).toMatchObject({
      urlFilter: '|http',
      resourceTypes: ['main_frame'],
      tabIds: [101],
    })
    expect(carrier.action.redirect.transform.queryTransform.addOrReplaceParams.map((entry) => entry.key)).toEqual([
      '__sessionshift_bootstrap',
      '__sessionshift_bootstrap_sig',
    ])
  })

  it('strips same-site subresource cookies too while response-side stripping stays strict', async () => {
    await setupProfile({
      sessionId: 'session_github',
      tabId: 12,
      tabUrl: 'https://github.com/login',
    })

    await updateDNRRulesForTab(12, 'session_github')

    const [{ addRules }] = chrome.declarativeNetRequest.updateSessionRules.mock.calls.at(-1)
    expect(addRules[0].condition.excludedRequestDomains).toBeUndefined()
    const responseRules = addRules.filter((rule) => rule.action.responseHeaders?.[0]?.header === 'set-cookie')
    expect(responseRules).toHaveLength(1)
    expect(responseRules[0].condition.excludedRequestDomains).toBeUndefined()
  })

  it('creates host/path-specific cookie rules so sibling subdomains do not receive host-only cookies', async () => {
    await setupProfile({
      sessionId: 'session_scoped',
      tabId: 13,
      tabUrl: 'https://www.google.com/',
      store: {
        [cookieKey('ROOT', '.google.com', '/')]: {
          name: 'ROOT',
          value: 'root',
          domain: '.google.com',
          path: '/',
          expires: null,
        },
        [cookieKey('ACCT', 'accounts.google.com', '/')]: {
          name: 'ACCT',
          value: 'acct',
          domain: 'accounts.google.com',
          path: '/',
          expires: null,
        },
        [cookieKey('ADMIN', '.google.com', '/admin')]: {
          name: 'ADMIN',
          value: 'admin',
          domain: '.google.com',
          path: '/admin',
          expires: null,
        },
      },
    })

    await updateDNRRulesForTab(13, 'session_scoped')

    const [{ addRules }] = chrome.declarativeNetRequest.updateSessionRules.mock.calls.at(-1)
    const accountRule = addRules.find((rule) => rule.condition.regexFilter === '^https://accounts\\.google\\.com(?::[0-9]+)?/')
    const accountAdminRule = addRules.find((rule) =>
      rule.condition.regexFilter === '^https://accounts\\.google\\.com(?::[0-9]+)?/admin(?:[/?#]|$)'
    )
    const domainRootRule = addRules.find((rule) =>
      rule.condition.urlFilter === '|https://' &&
      rule.condition.requestDomains?.includes('google.com') &&
      rule.action.requestHeaders?.[0]?.value === 'ROOT=root'
    )

    expect(accountRule.action.requestHeaders[0].value).toBe('ROOT=root; ACCT=acct')
    expect(accountAdminRule.action.requestHeaders[0].value).toBe('ADMIN=admin; ROOT=root; ACCT=acct')
    expect(domainRootRule.action.requestHeaders[0].value).not.toContain('ACCT=acct')
  })

  it('allows ports on exact-host rules for localhost development origins', async () => {
    await setupProfile({
      sessionId: 'session_localhost',
      tabId: 14,
      tabUrl: 'http://localhost:3000/',
      store: {
        [cookieKey('user', 'localhost', '/')]: {
          name: 'user',
          value: 'alice',
          domain: 'localhost',
          path: '/',
          expires: null,
        },
      },
    })

    await updateDNRRulesForTab(14, 'session_localhost')

    const [{ addRules }] = chrome.declarativeNetRequest.updateSessionRules.mock.calls.at(-1)
    const cookieRule = addRules.find((rule) => rule.action.requestHeaders?.[0]?.value === 'user=alice')
    expect(cookieRule.condition.regexFilter).toBe('^http://localhost(?::[0-9]+)?/')
  })
})
