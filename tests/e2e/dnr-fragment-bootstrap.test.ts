import { test, expect } from './extension-fixtures'

test('a tab-scoped DNR redirect can synchronously carry a startup fragment to only its bound tab', async ({
  context, extensionId, mockServerUrl,
}) => {
  const helper = await context.newPage()
  await helper.goto(`chrome-extension://${extensionId}/popup/popup.html`)

  const boundTab = await context.newPage()
  const defaultTab = await context.newPage()
  const [boundTabId, defaultTabId] = await helper.evaluate(async () => {
    const tabs = await chrome.tabs.query({})
    const ids = tabs
      .filter((tab) => tab.url === 'about:blank')
      .map((tab) => tab.id)
      .filter((id): id is number => id !== undefined)
    return [ids[ids.length - 2], ids[ids.length - 1]]
  })
  expect(boundTabId).toBeDefined()
  expect(defaultTabId).toBeDefined()

  const target = new URL('/cookies?bootstrap-probe=bound', mockServerUrl)
  const condition = `^${target.href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`
  await helper.evaluate(async ({ tabId, condition }) => {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [900_001],
      addRules: [{
        id: 900_001,
        priority: 10_000,
        action: {
          type: 'redirect',
          redirect: { transform: { fragment: '#__sessionshift_bootstrap_probe=profile-a' } },
        },
        condition: {
          regexFilter: condition,
          resourceTypes: ['main_frame'],
          tabIds: [tabId],
        },
      }],
    })
  }, { tabId: boundTabId!, condition })

  await boundTab.goto(target.href)
  await defaultTab.goto(target.href)

  expect(new URL(boundTab.url()).hash).toBe('#__sessionshift_bootstrap_probe=profile-a')
  expect(new URL(defaultTab.url()).hash).toBe('')

  await helper.evaluate(async () => {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [900_001] })
  })
  await helper.close()
})

test('a tab-scoped DNR query carrier preserves an application hash route', async ({
  context, extensionId, mockServerUrl,
}) => {
  const helper = await context.newPage()
  await helper.goto(`chrome-extension://${extensionId}/popup/popup.html`)

  const boundTab = await context.newPage()
  const defaultTab = await context.newPage()
  const [boundTabId, defaultTabId] = await helper.evaluate(async () => {
    const tabs = await chrome.tabs.query({})
    const ids = tabs
      .filter((tab) => tab.url === 'about:blank')
      .map((tab) => tab.id)
      .filter((id): id is number => id !== undefined)
    return [ids[ids.length - 2], ids[ids.length - 1]]
  })
  expect(boundTabId).toBeDefined()
  expect(defaultTabId).toBeDefined()

  const target = new URL('/cookies?existing=value#app-route', mockServerUrl)
  // The production carrier must apply to any HTTP or HTTPS navigation, not
  // just a precomputed destination. `|http` anchors the beginning and matches
  // both schemes while the tab restriction limits it to the Profile tab.
  const urlFilter = '|http'
  await helper.evaluate(async ({ tabId, urlFilter }) => {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [900_002],
      addRules: [{
        id: 900_002,
        priority: 10_000,
        action: {
          type: 'redirect',
          redirect: {
            transform: {
              queryTransform: {
                addOrReplaceParams: [{ key: '__sessionshift_bootstrap_probe', value: 'profile-a' }],
              },
            },
          },
        },
        condition: {
          urlFilter,
          resourceTypes: ['main_frame'],
          tabIds: [tabId],
        },
      }],
    })
  }, { tabId: boundTabId!, urlFilter })

  await boundTab.goto(target.href)
  await defaultTab.goto(target.href)

  const boundUrl = new URL(boundTab.url())
  expect(boundUrl.searchParams.get('existing')).toBe('value')
  expect(boundUrl.searchParams.get('__sessionshift_bootstrap_probe')).toBe('profile-a')
  expect(boundUrl.hash).toBe('#app-route')
  const defaultUrl = new URL(defaultTab.url())
  expect(defaultUrl.searchParams.get('existing')).toBe('value')
  expect(defaultUrl.searchParams.has('__sessionshift_bootstrap_probe')).toBe(false)
  expect(defaultUrl.hash).toBe('#app-route')

  await helper.evaluate(async () => {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [900_002] })
  })
  await helper.close()
})
