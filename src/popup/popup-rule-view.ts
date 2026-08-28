// popup-rule-view.ts — Rule list and editor for the Popup Rules view.

import type { Localizer } from '../lib/localization.js'
import type { ProfileRule, RuleMatch, Session } from '../lib/types.js'
import { getRuleProfileName, getRules, isOrphanedRule } from '../lib/rule-store.js'
import { resolveProfileForUrl, urlMatchesRule } from '../background/rule-resolver.js'
import { profileSwatchCss, resolveProfileHue } from '../lib/profile-color.js'

type RuleViewOptions = {
  root: HTMLElement
  profiles: () => Promise<Session[]>
  currentUrl: () => string
  localizer: Localizer
}

function text(localizer: Localizer, key: string, fallback: string, substitutions?: readonly string[]): string {
  return localizer.getMessage(key, substitutions) || fallback.replace(/\$([A-Za-z0-9_]+)\$/g, (_full, name: string) => {
    const index = name === 'profile' || name === 'id' || name === 'name' ? 0 : 1
    return substitutions?.[index] ?? _full
  })
}

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

function ruleSummary(rule: ProfileRule): string {
  const port = rule.match.port === undefined ? '' : `:${rule.match.port}`
  return `${rule.match.scheme}://${rule.match.hostname}${port}`
}

function ruleDraftFromForm(): { name: string; profileId: string; match: RuleMatch; enabled: boolean; priority: number } {
  const portValue = byId<HTMLInputElement>('rulePort').value.trim()
  const priorityText = byId<HTMLInputElement>('rulePriority').value.trim()
  const priorityValue = Number(priorityText)
  const regex = byId<HTMLInputElement>('ruleRegex').value
  return {
    name: byId<HTMLInputElement>('ruleName').value.trim(),
    profileId: byId<HTMLSelectElement>('ruleProfile').value,
    match: {
      scheme: byId<HTMLSelectElement>('ruleScheme').value as 'http' | 'https',
      hostname: byId<HTMLInputElement>('ruleHostname').value.trim(),
      ...(portValue ? { port: Number(portValue) } : {}),
      ...(regex ? { urlRegex: regex } : {}),
    },
    enabled: byId<HTMLInputElement>('ruleEnabled').checked,
    priority: priorityText && Number.isFinite(priorityValue) ? priorityValue : 100,
  }
}

export function createRuleView(options: RuleViewOptions): { refresh: () => Promise<void> } {
  const { root, profiles: loadProfiles, currentUrl, localizer } = options
  let editingRuleId: string | null = null
  let profileFillVersion = 0

  const list = root.querySelector('#ruleList') as HTMLElement
  const listPanel = root.querySelector('#ruleListPanel') as HTMLElement
  const formPanel = root.querySelector('#ruleFormPanel') as HTMLElement
  const listTab = root.querySelector('#ruleListTab') as HTMLButtonElement
  const formTab = root.querySelector('#ruleFormTab') as HTMLButtonElement
  const form = root.querySelector('#ruleForm') as HTMLFormElement
  const error = root.querySelector('#ruleFormError') as HTMLElement
  const preview = root.querySelector('#rulePreview') as HTMLElement

  function selectSubtab(tab: 'list' | 'form'): void {
    const listActive = tab === 'list'
    listPanel.hidden = !listActive
    formPanel.hidden = listActive
    listTab.classList.toggle('active', listActive)
    formTab.classList.toggle('active', !listActive)
    listTab.setAttribute('aria-selected', String(listActive))
    formTab.setAttribute('aria-selected', String(!listActive))
  }

  function showError(message: string): void {
    error.hidden = !message
    error.textContent = message
  }

  function resetForm(): void {
    editingRuleId = null
    selectSubtab('list')
    showError('')
    preview.textContent = ''
  }

  async function fillProfiles(selectedId = ''): Promise<void> {
    const version = ++profileFillVersion
    const profiles = await loadProfiles()
    if (version !== profileFillVersion) return
    const select = byId<HTMLSelectElement>('ruleProfile')
    select.replaceChildren()
    if (selectedId && !profiles.some((profile) => profile.id === selectedId)) {
      const orphan = document.createElement('option')
      orphan.value = selectedId
      orphan.textContent = text(localizer, 'ruleDeletedProfileReplacement', 'Deleted profile (choose a replacement)')
      orphan.selected = true
      orphan.disabled = true
      select.appendChild(orphan)
    }
    for (const [index, profile] of profiles.entries()) {
      const option = document.createElement('option')
      option.value = profile.id
      option.textContent = `● ${profile.name || profile.id} · ${profile.id.slice(-8)}`
      option.style.color = profileSwatchCss(resolveProfileHue(profile, index))
      option.selected = profile.id === selectedId
      select.appendChild(option)
    }
    if (profiles.length === 0) {
      const option = document.createElement('option')
      option.value = ''
      option.textContent = text(localizer, 'ruleCreateProfileFirst', 'Create a Profile first')
      option.disabled = true
      option.selected = true
      select.appendChild(option)
    }
  }

  async function refreshProfileOptions(): Promise<void> {
    if (formPanel.hidden) return
    const select = byId<HTMLSelectElement>('ruleProfile')
    await fillProfiles(select.value)
  }

  function populateForm(rule?: ProfileRule): void {
    const title = byId<HTMLElement>('ruleFormTitle')
    title.textContent = text(localizer, rule ? 'ruleFormEdit' : 'ruleFormNew', rule ? 'Edit rule' : 'New rule')
    byId<HTMLInputElement>('ruleName').value = rule?.name ?? ''
    byId<HTMLSelectElement>('ruleScheme').value = rule?.match.scheme ?? 'https'
    byId<HTMLInputElement>('ruleHostname').value = rule?.match.hostname ?? ''
    byId<HTMLInputElement>('rulePort').value = rule?.match.port === undefined ? '' : String(rule.match.port)
    byId<HTMLInputElement>('ruleRegex').value = rule?.match.urlRegex ?? ''
    byId<HTMLInputElement>('ruleEnabled').checked = rule?.enabled !== false
    byId<HTMLInputElement>('rulePriority').value = String(rule?.priority ?? 100)
    byId<HTMLInputElement>('ruleTestUrl').value = currentUrl()
    void fillProfiles(rule?.profileId)
    selectSubtab('form')
    showError('')
    updatePreview()
  }

  async function updatePreview(): Promise<void> {
    const url = byId<HTMLInputElement>('ruleTestUrl').value.trim() || currentUrl()
    const draft = ruleDraftFromForm()
    if (!url || !draft.name || !draft.profileId || !draft.match.hostname) {
      preview.textContent = ''
      return
    }
    const profiles = await loadProfiles()
    const rules = await getRules()
    const candidate: ProfileRule = {
      id: editingRuleId ?? 'preview-rule',
      ...draft,
    }
    const otherRules = rules.filter((rule) => rule.id !== editingRuleId)
    const resolution = resolveProfileForUrl(url, [...otherRules, candidate], profiles)
    if (isOrphanedRule(candidate, profiles)) {
      preview.textContent = text(localizer, 'rulePreviewDeleted', 'Deleted profile — choose a replacement before saving.')
      preview.className = 'v2-rule-preview is-conflict'
    } else if (resolution?.ruleId === candidate.id) {
      const profileName = getRuleProfileName(candidate, profiles)
      preview.textContent = text(localizer, 'rulePreviewMatch', 'Matches current URL → $profile$ ($rule$)', [profileName, candidate.name])
      preview.className = 'v2-rule-preview is-match'
    } else if (urlMatchesRule(url, candidate)) {
      preview.textContent = text(localizer, 'rulePreviewConflict', 'Current URL matches, but another rule has higher priority.')
      preview.className = 'v2-rule-preview is-conflict'
    } else {
      preview.textContent = text(localizer, 'rulePreviewNoMatch', 'Does not match the current URL.')
      preview.className = 'v2-rule-preview'
    }
  }

  function renderRuleCard(rule: ProfileRule, profiles: Session[]): HTMLElement {
    const orphaned = isOrphanedRule(rule, profiles)
    const card = document.createElement('article')
    card.className = 'v2-rule-card'
    card.dataset.ruleId = rule.id

    const body = document.createElement('div')
    body.className = 'v2-rule-card-body'
    const name = document.createElement('div')
    name.className = 'v2-rule-card-name'
    name.textContent = rule.name || rule.id
    const meta = document.createElement('div')
    meta.className = 'v2-rule-card-meta'
    meta.textContent = `${ruleSummary(rule)} → ${orphaned ? text(localizer, 'ruleDeletedProfile', 'Deleted profile') : getRuleProfileName(rule, profiles)}`
    const id = document.createElement('div')
    id.className = 'v2-rule-card-id'
    id.textContent = text(localizer, 'rulePriorityMeta', '$id$ · priority $priority$', [rule.id, String(rule.priority)])
    body.append(name, meta, id)

    const actions = document.createElement('div')
    actions.className = 'v2-rule-card-actions'
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'v2-rule-action'
    toggle.textContent = rule.enabled === false
      ? text(localizer, 'ruleOff', 'Off') : text(localizer, 'ruleOn', 'On')
    toggle.title = rule.enabled === false
      ? text(localizer, 'ruleEnable', 'Enable rule') : text(localizer, 'ruleDisable', 'Disable rule')
    toggle.addEventListener('click', async (event) => {
      event.stopPropagation()
      await chrome.runtime.sendMessage({ action: 'setRuleEnabled', payload: { ruleId: rule.id, enabled: rule.enabled === false } })
      await refresh()
    })
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'v2-rule-action'
    copy.textContent = text(localizer, 'ruleCopy', 'Copy')
    copy.disabled = orphaned
    copy.title = orphaned
      ? text(localizer, 'ruleDeletedProfileReplacement', 'Deleted profile (choose a replacement)')
      : text(localizer, 'ruleCopy', 'Copy')
    copy.addEventListener('click', async (event) => {
      event.stopPropagation()
      const result = await chrome.runtime.sendMessage({
        action: 'createRule',
        payload: {
          name: text(localizer, 'ruleCopyName', '$name$ (copy)', [rule.name || rule.id]),
          profileId: rule.profileId,
          match: rule.match,
          enabled: rule.enabled !== false,
          priority: rule.priority,
        },
      })
      if (!result?.success) {
        showError(result?.error || text(localizer, 'ruleSaveError', 'Could not save rule'))
        return
      }
      await refresh()
    })
    const edit = document.createElement('button')
    edit.type = 'button'
    edit.className = 'v2-rule-action'
    edit.textContent = text(localizer, 'ruleEdit', 'Edit')
    edit.addEventListener('click', (event) => {
      event.stopPropagation()
      editingRuleId = rule.id
      populateForm(rule)
    })
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'v2-rule-action danger'
    remove.textContent = text(localizer, 'ruleDelete', 'Delete')
    remove.addEventListener('click', async (event) => {
      event.stopPropagation()
      const ruleName = rule.name || rule.id
      if (!window.confirm(text(localizer, 'ruleDeleteConfirm', 'Delete rule “$name$”?', [ruleName]))) return
      await chrome.runtime.sendMessage({ action: 'deleteRule', payload: { ruleId: rule.id } })
      if (editingRuleId === rule.id) resetForm()
      await refresh()
    })
    actions.append(toggle, copy, edit, remove)
    if (orphaned) {
      const badge = document.createElement('span')
      badge.className = 'v2-rule-orphan'
      badge.textContent = text(localizer, 'ruleDeletedProfile', 'Deleted profile')
      actions.prepend(badge)
    }
    card.append(body, actions)
    if (rule.enabled === false || orphaned) card.classList.add('is-disabled')
    return card
  }

  async function refresh(): Promise<void> {
    const [rules, profiles] = await Promise.all([getRules(), loadProfiles()])
    formTab.disabled = profiles.length === 0
    formTab.title = profiles.length === 0
      ? text(localizer, 'ruleCreateProfileFirst', 'Create a Profile first')
      : text(localizer, 'newRuleButton', 'New rule')
    list.replaceChildren()
    if (rules.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'v2-rule-empty'
      empty.textContent = profiles.length === 0
        ? text(localizer, 'ruleEmptyNoProfiles', 'Create a Profile first, then add a Rule for URL routing.')
        : text(localizer, 'ruleEmptyNoRules', 'No rules yet. Create one to route a URL to a Profile.')
      list.appendChild(empty)
    } else {
      for (const rule of rules) list.appendChild(renderRuleCard(rule, profiles))
    }
    await refreshProfileOptions()
  }

  listTab.addEventListener('click', () => selectSubtab('list'))
  formTab.addEventListener('click', () => {
    editingRuleId = null
    populateForm()
  })
  root.querySelector('#btnCancelRule')?.addEventListener('click', resetForm)
  root.querySelector('#btnUseCurrentUrl')?.addEventListener('click', () => {
    try {
      const url = new URL(currentUrl())
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        byId<HTMLInputElement>('ruleTestUrl').value = url.href
        byId<HTMLSelectElement>('ruleScheme').value = url.protocol.slice(0, -1)
        byId<HTMLInputElement>('ruleHostname').value = url.hostname
        byId<HTMLInputElement>('rulePort').value = url.port
        void updatePreview()
      }
    } catch {
      showError(text(localizer, 'ruleInvalidPage', 'The current page is not an HTTP(S) URL.'))
    }
  })
  form.addEventListener('input', () => { void updatePreview() })
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    showError('')
    try {
      const draft = ruleDraftFromForm()
      const result = editingRuleId
        ? await chrome.runtime.sendMessage({
          action: 'updateRule',
          payload: { rule: { id: editingRuleId, ...draft } },
        })
        : await chrome.runtime.sendMessage({ action: 'createRule', payload: draft })
      if (!result?.success) throw new Error(result?.error || text(localizer, 'ruleSaveError', 'Could not save rule'))
      resetForm()
      await refresh()
    } catch (saveError) {
      // The store currently returns English diagnostic strings. Keep those
      // implementation details out of the UI and show the localized generic
      // save/validation error instead.
      void saveError
      showError(text(localizer, 'ruleSaveError', 'Could not save rule'))
    }
  })

  // Keep the localizer in the module contract so future localized rule strings
  // can be added without changing the view wiring. Existing UI strings retain
  // English fallbacks when a locale has not yet received the new catalog keys.
  void text(localizer, 'rulesTab', 'Rules')

  return { refresh }
}
