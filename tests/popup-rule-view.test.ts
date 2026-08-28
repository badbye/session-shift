import { describe, expect, it, vi } from 'vitest'
import { createRuleView } from '../src/popup/popup-rule-view.js'
import type { Session } from '../src/lib/types.js'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

function makeRuleViewRoot(): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = `
    <button id="btnNewRule" type="button"></button>
    <div id="ruleList"></div>
    <form id="ruleForm" hidden>
      <div id="ruleFormTitle"></div>
      <input id="ruleName">
      <select id="ruleProfile"></select>
      <select id="ruleScheme"><option value="https">https</option></select>
      <input id="ruleHostname">
      <input id="rulePort">
      <input id="ruleRegex">
      <input id="ruleEnabled" type="checkbox" checked>
      <input id="rulePriority" value="100">
      <input id="ruleTestUrl">
      <div id="rulePreview"></div>
      <div id="ruleFormError"></div>
      <button id="btnCancelRule" type="button"></button>
    </form>
    <button id="btnUseCurrentUrl" type="button"></button>
  `
  document.body.appendChild(root)
  return root
}

describe('popup RuleView profile options', () => {
  it('does not let an older profile load overwrite the post-create refresh', async () => {
    const root = makeRuleViewRoot()
    const firstLoad = deferred<Session[]>()
    const profile = { id: 'profile_a', name: 'A' }
    const createdProfile = { id: 'profile_b', name: 'B' }
    let loadCount = 0
    const loadProfiles = vi.fn(() => {
      loadCount += 1
      return loadCount === 1
        ? firstLoad.promise
        : Promise.resolve([profile, createdProfile])
    })

    const view = createRuleView({
      root,
      profiles: loadProfiles,
      currentUrl: () => 'https://example.com/',
      localizer: { preference: 'system', languageTag: 'en', direction: 'ltr', getMessage: () => '' },
    })

    root.querySelector<HTMLButtonElement>('#btnNewRule')!.click()
    const refresh = view.refresh()
    await refresh

    firstLoad.resolve([profile])
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect([...root.querySelectorAll<HTMLOptionElement>('#ruleProfile option')].map((option) => option.value))
      .toEqual(['profile_a', 'profile_b'])
  })
})
