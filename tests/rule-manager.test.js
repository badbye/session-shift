import { beforeEach, describe, expect, it } from 'vitest'
import { applyAutomaticProfileForTab, registerRuleNavigationListener } from '../background/rule-manager.js'
import { setRules } from '../lib/rule-store.js'
import { setProfiles } from '../lib/session-store.js'
import {
  getTabBindingMeta,
  setTabBindingMeta,
  tabBindingMeta,
  tabSessions,
} from '../background/session-manager.js'
import { bindTabToProfile } from '../background/session-binding.js'

beforeEach(() => {
  for (const key of Object.keys(tabSessions)) delete tabSessions[key]
  for (const key of Object.keys(tabBindingMeta)) delete tabBindingMeta[key]
})

describe('automatic profile routing', () => {
  it('binds a matching URL to the rule target and records rule provenance', async () => {
    await setProfiles([{ id: 'p-dev', name: 'Dev' }])
    await setRules([{
      id: 'rule-dev', name: 'Dev rule', profileId: 'p-dev', enabled: true, priority: 100,
      match: { scheme: 'https', hostname: 'dev.example.com' },
    }])
    chrome.tabs.get.mockResolvedValue({ id: 7, url: 'https://dev.example.com/', windowId: 1 })

    const result = await applyAutomaticProfileForTab(7, 'https://dev.example.com/')

    expect(result?.ruleId).toBe('rule-dev')
    expect(tabSessions[7]).toBe('p-dev')
    expect(getTabBindingMeta(7)).toEqual({ source: 'rule', ruleId: 'rule-dev' })
    expect(chrome.declarativeNetRequest.updateSessionRules).toHaveBeenCalled()
  })

  it('ignores orphaned rules and resets a previous rule binding to default', async () => {
    await setProfiles([])
    await setRules([{
      id: 'rule-deleted', name: 'Deleted', profileId: 'deleted', enabled: true, priority: 100,
      match: { scheme: 'https', hostname: 'dev.example.com' },
    }])
    tabSessions[8] = 'deleted'
    setTabBindingMeta(8, { source: 'rule', ruleId: 'rule-deleted' })
    chrome.tabs.get.mockResolvedValue({ id: 8, url: 'https://dev.example.com/', windowId: 1 })

    await applyAutomaticProfileForTab(8, 'https://dev.example.com/')

    expect(tabSessions[8]).toBe('default')
    expect(getTabBindingMeta(8)).toEqual({ source: 'default' })
  })

  it('does not override a manual tab binding', async () => {
    await setProfiles([{ id: 'p-dev', name: 'Dev' }])
    await setRules([{
      id: 'rule-dev', name: 'Dev rule', profileId: 'p-dev', enabled: true, priority: 100,
      match: { scheme: 'https', hostname: 'dev.example.com' },
    }])
    tabSessions[9] = 'manual-profile'
    setTabBindingMeta(9, { source: 'manual' })

    await applyAutomaticProfileForTab(9, 'https://dev.example.com/')

    expect(tabSessions[9]).toBe('manual-profile')
    expect(getTabBindingMeta(9)).toEqual({ source: 'manual' })
  })

  it('does not notify the unloading document during an automatic navigation bind', async () => {
    await setProfiles([{ id: 'p-prod', name: 'Prod' }])

    await bindTabToProfile(10, 'p-prod', { source: 'rule', ruleId: 'rule-prod' }, {
      navigationUrl: 'https://prod.example.com/',
    })

    expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(10, { action: 'sessionBootstrapChanged' })
  })
})

describe('registerRuleNavigationListener', () => {
  it('registers a top-level webNavigation listener', () => {
    registerRuleNavigationListener(Promise.resolve())
    expect(chrome.webNavigation.onBeforeNavigate.addListener).toHaveBeenCalled()
  })
})
