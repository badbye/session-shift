import { test, expect } from './extension-fixtures'

test('an unbound ordinary-HTTP tab keeps native startup APIs', async ({
  context, insecureHttpServerUrl,
}) => {
  const tab = await context.newPage()
  await tab.goto(`${insecureHttpServerUrl}/startup-api?default-startup=1`)
  await tab.waitForFunction(() => window.__sessionShiftStartup?.idbReady === true)
  const startup = await tab.evaluate(() => ({
    state: window.__sessionShiftStartup,
    localValue: localStorage.getItem('startup-key'),
  }))

  expect(startup.state.secure).toBe(false)
  expect(startup.state.idbError).toBeNull()
  expect(startup.state.idbRequest).toBe(true)
  expect(startup.localValue).toBe('profile-value')
})

test('a bound Profile synchronously namespaces IndexedDB on ordinary HTTP', async ({
  context, extensionId, insecureHttpServerUrl,
}) => {
  const sessionId = `session_http_startup_${Date.now()}`
  const helper = await context.newPage()
  await helper.goto(`chrome-extension://${extensionId}/popup/popup.html`)
  await helper.evaluate(async (sessionId) => {
    await chrome.storage.local.set({
      profiles: [{ id: sessionId, name: 'HTTP startup', hue: 212 }],
      [`cookies_${sessionId}`]: {},
    })
  }, sessionId)

  const tab = await context.newPage()
  await tab.goto(`${insecureHttpServerUrl}/cookies?startup-tab=1`)
  const tabId = await helper.evaluate(async () => (await chrome.tabs.query({}))
    .find((candidate) => candidate.url?.includes('startup-tab=1'))?.id)
  expect(tabId).toBeDefined()

  await helper.evaluate(
    ({ tabId, sessionId }) => chrome.runtime.sendMessage({
      action: 'setSession', payload: { tabId, sessionId },
    }),
    { tabId, sessionId },
  )

  await tab.goto(`${insecureHttpServerUrl}/startup-api?profile-startup=1#application-route`)
  await tab.waitForFunction(() => window.__sessionShiftStartup?.idbReady === true)
  const startup = await tab.evaluate(async () => ({
    state: window.__sessionShiftStartup,
    localValue: localStorage.getItem('startup-key'),
    databases: typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [],
    url: location.href,
  }))

  expect(startup.state.secure).toBe(false)
  expect(startup.state.idbError).toBeNull()
  expect(startup.state.idbRequest).toBe(true)
  expect(startup.localValue).toBe('profile-value')
  expect(startup.databases).toContainEqual(expect.objectContaining({ name: 'startup-db' }))
  expect(new URL(startup.url).searchParams.has('__sessionshift_bootstrap')).toBe(false)
  expect(new URL(startup.url).searchParams.has('__sessionshift_bootstrap_sig')).toBe(false)
  expect(new URL(startup.url).hash).toBe('#application-route')
  await helper.close()
})
