// popup-storage-view.ts — Profile-aware inspection of the current page's storage.

import type { Localizer } from '../lib/localization.js'
import { cookieMatchesRequest } from '../lib/cookie-parser.js'
import { getCookieStore } from '../lib/session-store.js'
import type { CookieStoreEntry } from '../lib/session-store.js'

type StorageKind = 'localStorage' | 'sessionStorage' | 'cookies'

type StorageCookie = {
  name: string
  value: string
  domain?: string | null
  path?: string | null
  expires?: number | null
  secure?: boolean
  httpOnly?: boolean
  sameSite?: string | null
}

type StorageSnapshot = {
  localStorage: Record<string, string>
  sessionStorage: Record<string, string>
  cookies: StorageCookie[]
}

type StorageViewOptions = {
  root: HTMLElement
  tabId?: number
  currentUrl: string
  currentProfileId: string
  currentProfileName: string
  localizer: Localizer
}

type PageState = { page: number; pageSize: 10 | 20 | 50 }

function message(localizer: Localizer, key: string, fallback: string): string {
  return localizer.getMessage(key) || fallback
}

function isHttpUrl(value: string): boolean {
  return /^https?:/i.test(value)
}

function requestUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    return url.href
  } catch {
    return value
  }
}

function storagePrefix(profileId: string): string {
  return profileId === 'default' ? '' : `__ext_${profileId}_`
}

function isJson(value: string): boolean {
  if (!value) return false
  try {
    const parsed = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null
  } catch {
    return false
  }
}

function displayValue(value: string): string {
  if (!isJson(value)) return value
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

function cookieFromProfileEntry(key: string, entry: CookieStoreEntry): StorageCookie {
  return {
    name: entry.name || key,
    value: entry.value,
    domain: entry.domain,
    path: entry.path,
    expires: entry.expires,
    secure: entry.secure,
    httpOnly: entry.httpOnly,
    sameSite: entry.sameSite,
  }
}

function cookieFromBrowserEntry(cookie: chrome.cookies.Cookie): StorageCookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.expirationDate == null ? null : cookie.expirationDate * 1000,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
  }
}

export function createStorageView(options: StorageViewOptions): { refresh: () => Promise<void> } {
  const { root, tabId, currentUrl, currentProfileId, currentProfileName, localizer } = options
  const context = root.querySelector<HTMLElement>('#storageContext')!
  const list = root.querySelector<HTMLElement>('#storageList')!
  const empty = root.querySelector<HTMLElement>('#storageEmpty')!
  const emptyTitle = root.querySelector<HTMLElement>('#storageEmptyTitle')!
  const emptySubtitle = root.querySelector<HTMLElement>('#storageEmptySubtitle')!
  const status = root.querySelector<HTMLElement>('#storageStatus')!
  const search = root.querySelector<HTMLInputElement>('#storageSearch')!
  const clearSearch = root.querySelector<HTMLButtonElement>('#storageClearSearch')!
  const refreshButton = root.querySelector<HTMLButtonElement>('#storageRefresh')!
  const pagination = root.querySelector<HTMLElement>('#storagePagination')!
  const previousPage = root.querySelector<HTMLButtonElement>('#storagePreviousPage')!
  const nextPage = root.querySelector<HTMLButtonElement>('#storageNextPage')!
  const pageInfo = root.querySelector<HTMLElement>('#storagePageInfo')!
  const pageTotal = root.querySelector<HTMLElement>('#storagePageTotal')!
  const pageSizeSelect = root.querySelector<HTMLSelectElement>('#storagePageSize')!
  const subtabButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-storage-tab]'))

  let currentTab: StorageKind = 'localStorage'
  let searchQuery = ''
  let refreshGeneration = 0
  let snapshot: StorageSnapshot = { localStorage: {}, sessionStorage: {}, cookies: [] }
  const pageStates: Record<StorageKind, PageState> = {
    localStorage: { page: 1, pageSize: 10 },
    sessionStorage: { page: 1, pageSize: 10 },
    cookies: { page: 1, pageSize: 10 },
  }

  let pageHost = currentUrl
  try { pageHost = new URL(currentUrl).host } catch { /* keep the raw URL */ }
  context.textContent = `${pageHost} · ${currentProfileName}`

  function setStatus(value: string): void {
    status.textContent = value
  }

  function updateCounts(): void {
    const counts: Record<StorageKind, number> = {
      localStorage: Object.keys(snapshot.localStorage).length,
      sessionStorage: Object.keys(snapshot.sessionStorage).length,
      cookies: snapshot.cookies.length,
    }
    for (const button of subtabButtons) {
      const count = button.querySelector<HTMLElement>('[data-storage-count]')
      if (count) count.textContent = String(counts[button.dataset.storageTab as StorageKind])
    }
  }

  function selectSubtab(tab: StorageKind): void {
    currentTab = tab
    for (const button of subtabButtons) {
      const active = button.dataset.storageTab === tab
      button.classList.toggle('active', active)
      button.setAttribute('aria-selected', String(active))
    }
    render()
  }

  function matchingEntries(): Array<{ key: string; value: string; cookie?: StorageCookie }> {
    const query = searchQuery.trim().toLowerCase()
    if (currentTab === 'cookies') {
      return snapshot.cookies
        .filter((cookie) => !query || cookie.name.toLowerCase().includes(query) || cookie.value.toLowerCase().includes(query))
        .map((cookie) => ({ key: cookie.name, value: cookie.value, cookie }))
    }

    return Object.entries(snapshot[currentTab])
      .filter(([key, value]) => !query || key.toLowerCase().includes(query) || value.toLowerCase().includes(query))
      .map(([key, value]) => ({ key, value }))
  }

  function appendCookieMeta(container: HTMLElement, cookie: StorageCookie): void {
    const meta = document.createElement('div')
    meta.className = 'v2-storage-cookie-meta'
    const fields: Array<[string, string]> = [
      ['Domain', cookie.domain || '(host)'],
      ['Path', cookie.path || '/'],
      ['SameSite', cookie.sameSite || 'unspecified'],
    ]
    if (cookie.expires == null) fields.push(['Lifetime', 'Session'])
    else fields.push(['Expires', new Date(cookie.expires).toLocaleString()])
    if (cookie.secure) fields.push(['Flag', 'Secure'])
    if (cookie.httpOnly) fields.push(['Flag', 'HttpOnly'])

    for (const [label, value] of fields) {
      const item = document.createElement('span')
      item.className = 'v2-storage-cookie-meta-item'
      const labelElement = document.createElement('span')
      labelElement.className = 'v2-storage-cookie-meta-label'
      labelElement.textContent = `${label}:`
      item.append(labelElement, document.createTextNode(` ${value}`))
      meta.appendChild(item)
    }
    container.appendChild(meta)
  }

  function renderItem(entry: { key: string; value: string; cookie?: StorageCookie }): HTMLElement {
    const item = document.createElement('article')
    item.className = 'v2-storage-item'

    const header = document.createElement('div')
    header.className = 'v2-storage-item-header'
    header.tabIndex = 0
    header.setAttribute('role', 'button')
    header.setAttribute('aria-expanded', 'false')

    const keyWrap = document.createElement('div')
    keyWrap.className = 'v2-storage-item-key'
    const key = document.createElement('span')
    key.className = 'v2-storage-key'
    key.dir = 'auto'
    key.title = entry.key
    key.textContent = entry.key
    const type = document.createElement('span')
    type.className = `v2-storage-type${entry.cookie ? '' : isJson(entry.value) ? ' json' : ''}`
    type.textContent = entry.cookie ? 'cookie' : isJson(entry.value) ? 'json' : 'string'
    keyWrap.append(key, type)

    const actions = document.createElement('div')
    actions.className = 'v2-storage-item-actions'
    const copy = document.createElement('button')
    copy.className = 'v2-storage-copy'
    copy.type = 'button'
    copy.textContent = 'Copy'
    copy.title = 'Copy value'
    copy.addEventListener('click', async (event) => {
      event.stopPropagation()
      try {
        await navigator.clipboard.writeText(entry.value)
        setStatus('Copied')
      } catch {
        setStatus('Copy failed')
      }
    })
    actions.appendChild(copy)

    const expand = document.createElement('span')
    expand.className = 'v2-storage-expand'
    expand.textContent = '⌄'
    header.append(keyWrap, actions, expand)

    const content = document.createElement('div')
    content.className = 'v2-storage-item-content'
    content.hidden = true
    const value = document.createElement('pre')
    value.className = 'v2-storage-value'
    value.dir = 'auto'
    value.textContent = displayValue(entry.value)
    content.appendChild(value)
    if (entry.cookie) appendCookieMeta(content, entry.cookie)

    const toggle = (): void => {
      const expanded = !content.hidden
      content.hidden = expanded
      item.classList.toggle('expanded', !expanded)
      header.setAttribute('aria-expanded', String(!expanded))
    }
    header.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('button')) return
      toggle()
    })
    header.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        toggle()
      }
    })

    item.append(header, content)
    return item
  }

  function render(): void {
    const allEntries = matchingEntries()
    const pageState = pageStates[currentTab]
    const pageCount = Math.max(1, Math.ceil(allEntries.length / pageState.pageSize))
    pageState.page = Math.min(pageState.page, pageCount)
    const firstIndex = (pageState.page - 1) * pageState.pageSize
    const entries = allEntries.slice(firstIndex, firstIndex + pageState.pageSize)

    list.replaceChildren(...entries.map(renderItem))
    empty.hidden = allEntries.length > 0
    emptyTitle.textContent = searchQuery
      ? 'No matching data'
      : message(localizer, 'storageEmptyTitle', 'No data')
    emptySubtitle.textContent = searchQuery
      ? 'Try a different search.'
      : 'This Profile has no stored values for the current page.'
    clearSearch.hidden = !searchQuery
    pagination.hidden = allEntries.length === 0
    pageInfo.textContent = `${pageState.page} / ${pageCount}`
    pageTotal.textContent = `${allEntries.length} item${allEntries.length === 1 ? '' : 's'}`
    pageSizeSelect.value = String(pageState.pageSize)
    previousPage.disabled = pageState.page <= 1
    nextPage.disabled = pageState.page >= pageCount
    updateCounts()
  }

  async function readWebStorage(kind: 'localStorage' | 'sessionStorage'): Promise<Record<string, string>> {
    if (tabId === undefined || !isHttpUrl(currentUrl)) return {}
    const prefix = storagePrefix(currentProfileId)
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        func: (storageKind: 'localStorage' | 'sessionStorage', keyPrefix: string) => {
          const storage = storageKind === 'localStorage' ? window.localStorage : window.sessionStorage
          const output: Record<string, string> = {}
          for (let index = 0; index < storage.length; index++) {
            const rawKey = storage.key(index)
            if (rawKey === null || (keyPrefix && !rawKey.startsWith(keyPrefix))) continue
            const key = keyPrefix ? rawKey.slice(keyPrefix.length) : rawKey
            output[key] = storage.getItem(rawKey) ?? ''
          }
          return output
        },
        args: [kind, prefix],
      })
      const result = results[0]?.result
      return result && typeof result === 'object' ? result as Record<string, string> : {}
    } catch {
      return {}
    }
  }

  async function readCookies(): Promise<StorageCookie[]> {
    if (tabId === undefined || !isHttpUrl(currentUrl)) return []
    const url = requestUrl(currentUrl)
    try {
      if (currentProfileId === 'default') {
        const cookies = await chrome.cookies.getAll({ url })
        return cookies.map(cookieFromBrowserEntry)
      }

      const store = await getCookieStore(currentProfileId)
      const now = Date.now()
      return Object.entries(store)
        .filter(([, entry]) => (entry.expires == null || entry.expires > now) && cookieMatchesRequest(entry, url))
        .map(([key, entry]) => cookieFromProfileEntry(key, entry))
    } catch {
      return []
    }
  }

  async function refresh(): Promise<void> {
    const generation = ++refreshGeneration
    if (!isHttpUrl(currentUrl) || tabId === undefined) {
      snapshot = { localStorage: {}, sessionStorage: {}, cookies: [] }
      setStatus(message(localizer, 'cannotIsolatePage', 'Storage unavailable for this page.'))
      render()
      return
    }

    refreshButton.disabled = true
    setStatus('Loading…')
    const [localStorage, sessionStorage, cookies] = await Promise.all([
      readWebStorage('localStorage'),
      readWebStorage('sessionStorage'),
      readCookies(),
    ])
    if (generation !== refreshGeneration) return
    snapshot = { localStorage, sessionStorage, cookies }
    refreshButton.disabled = false
    setStatus('')
    render()
  }

  for (const button of subtabButtons) {
    button.addEventListener('click', () => selectSubtab(button.dataset.storageTab as StorageKind))
  }
  search.addEventListener('input', () => {
    searchQuery = search.value
    pageStates[currentTab].page = 1
    render()
  })
  clearSearch.addEventListener('click', () => {
    search.value = ''
    searchQuery = ''
    pageStates[currentTab].page = 1
    render()
    search.focus()
  })
  previousPage.addEventListener('click', () => {
    pageStates[currentTab].page = Math.max(1, pageStates[currentTab].page - 1)
    render()
  })
  nextPage.addEventListener('click', () => {
    pageStates[currentTab].page += 1
    render()
  })
  pageSizeSelect.addEventListener('change', () => {
    const value = Number(pageSizeSelect.value)
    if (value !== 10 && value !== 20 && value !== 50) return
    pageStates[currentTab].pageSize = value
    pageStates[currentTab].page = 1
    render()
  })
  refreshButton.addEventListener('click', () => { void refresh() })

  selectSubtab(currentTab)
  return { refresh }
}
