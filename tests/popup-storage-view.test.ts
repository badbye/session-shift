import { describe, expect, it, vi } from 'vitest'
import { createStorageView } from '../src/popup/popup-storage-view.js'

function makeStorageRoot(): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = `
    <div id="storageContext"></div>
    <button data-storage-tab="localStorage"><span>Local</span><span data-storage-count>0</span></button>
    <button data-storage-tab="sessionStorage"><span>Session</span><span data-storage-count>0</span></button>
    <button data-storage-tab="cookies"><span>Cookies</span><span data-storage-count>0</span></button>
    <button id="storageRefresh" type="button"></button>
    <input id="storageSearch">
    <button id="storageClearSearch" type="button" hidden></button>
    <div id="storageStatus"></div>
    <div id="storagePanel"><div id="storageList"></div><div id="storageEmpty" hidden><div id="storageEmptyTitle"></div><div id="storageEmptySubtitle"></div></div><div id="storagePagination" hidden><button id="storagePreviousPage"></button><span id="storagePageInfo"></span><button id="storageNextPage"></button><select id="storagePageSize"><option value="10">10</option><option value="20">20</option><option value="50">50</option></select><span id="storagePageTotal"></span></div></div>
  `
  document.body.appendChild(root)
  return root
}

describe('popup StorageView', () => {
  it('reads Web Storage with the active Profile prefix and reads that Profile cookie store', async () => {
    const root = makeStorageRoot()
    const chromeMock = globalThis.chrome as typeof globalThis.chrome & {
      scripting: { executeScript: ReturnType<typeof vi.fn> }
      cookies: { getAll: ReturnType<typeof vi.fn> }
    }
    const executeScript = vi.fn(async (details: { args: [string, string] }) => {
      const [kind, prefix] = details.args
      return [{
        result: kind === 'localStorage'
          ? { [`${prefix}token`]: 'profile-token' }
          : { [`${prefix}tab`]: 'profile-tab' },
      }]
    })
    chromeMock.scripting = { executeScript }
    chromeMock.cookies = { getAll: vi.fn() }
    await chromeMock.storage.local.set({
      cookies_profile_a: {
        auth: { name: 'auth', value: 'cookie-value', domain: 'example.com', path: '/' },
      },
    })

    const view = createStorageView({
      root,
      tabId: 7,
      currentUrl: 'https://example.com/app',
      currentProfileId: 'profile_a',
      currentProfileName: 'Work',
      localizer: { preference: 'system', languageTag: 'en', direction: 'ltr', getMessage: () => '' },
    })

    await view.refresh()

    expect(executeScript).toHaveBeenCalledTimes(2)
    expect(executeScript.mock.calls.map(([details]) => details.args[1])).toEqual([
      '__ext_profile_a_',
      '__ext_profile_a_',
    ])
    expect(root.querySelector<HTMLElement>('#storageContext')!.textContent).toBe('example.com · Work')
    expect(root.querySelector<HTMLElement>('[data-storage-tab="localStorage"] [data-storage-count]')!.textContent).toBe('1')
    expect(root.querySelector<HTMLElement>('#storageList')!.textContent).toContain('token')

    root.querySelector<HTMLButtonElement>('[data-storage-tab="cookies"]')!.click()
    expect(root.querySelector<HTMLElement>('[data-storage-tab="cookies"] [data-storage-count]')!.textContent).toBe('1')
    expect(root.querySelector<HTMLElement>('#storageList')!.textContent).toContain('auth')
    expect(chromeMock.cookies.getAll).not.toHaveBeenCalled()
  })

  it('searches the full active subtab and keeps pagination state independent per subtab', async () => {
    const root = makeStorageRoot()
    const chromeMock = globalThis.chrome as typeof globalThis.chrome & {
      scripting: { executeScript: ReturnType<typeof vi.fn> }
      cookies: { getAll: ReturnType<typeof vi.fn> }
    }
    const executeScript = vi.fn(async (details: { args: [string, string] }) => {
      const [kind, prefix] = details.args
      const result: Record<string, string> = {}
      for (let index = 0; index < (kind === 'localStorage' ? 25 : 2); index++) {
        result[`${prefix}${kind}_${index}`] = `value-${index}`
      }
      return [{ result }]
    })
    chromeMock.scripting = { executeScript }
    chromeMock.cookies = { getAll: vi.fn() }

    const view = createStorageView({
      root,
      tabId: 7,
      currentUrl: 'https://example.com/app',
      currentProfileId: 'profile_a',
      currentProfileName: 'Work',
      localizer: { preference: 'system', languageTag: 'en', direction: 'ltr', getMessage: () => '' },
    })

    await view.refresh()
    expect(root.querySelectorAll('#storageList .v2-storage-item')).toHaveLength(10)
    expect(root.querySelector('#storagePageInfo')!.textContent).toBe('1 / 3')

    root.querySelector<HTMLButtonElement>('#storageNextPage')!.click()
    expect(root.querySelector('#storagePageInfo')!.textContent).toBe('2 / 3')
    expect(root.querySelector('#storageList')!.textContent).toContain('localStorage_10')

    root.querySelector<HTMLButtonElement>('[data-storage-tab="sessionStorage"]')!.click()
    expect(root.querySelector('#storagePageInfo')!.textContent).toBe('1 / 1')
    expect(root.querySelectorAll('#storageList .v2-storage-item')).toHaveLength(2)

    root.querySelector<HTMLButtonElement>('[data-storage-tab="localStorage"]')!.click()
    expect(root.querySelector('#storagePageInfo')!.textContent).toBe('2 / 3')

    const search = root.querySelector<HTMLInputElement>('#storageSearch')!
    search.value = 'localStorage_24'
    search.dispatchEvent(new Event('input'))
    expect(root.querySelector('#storagePageInfo')!.textContent).toBe('1 / 1')
    expect(root.querySelectorAll('#storageList .v2-storage-item')).toHaveLength(1)
    expect(root.querySelector('#storageList')!.textContent).toContain('localStorage_24')
  })
})
