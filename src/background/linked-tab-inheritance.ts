// linked-tab-inheritance.ts — Opt-out: new tabs opened from a link inherit the opener's profile.
// Default on — `autoInheritProfileForLinkedTabs === false` is the only way to disable it;
// absent/undefined (e.g. pre-existing users, freshly-installed extension) means enabled.

import { getTabBindingMeta, tabSessions } from './session-manager.js'
import { isInternalSession } from '../lib/session-store.js'
import { getExtSettings } from '../lib/settings-store.js'
import { getNavigationGeneration, resolveRuleForUrl } from './rule-manager.js'
import { bindTabToProfile } from './session-binding.js'

// `tabs.onCreated` fires before the destination URL is known for target="_blank"
// / ctrl-click / middle-click tabs (tab.url is "" and tab.pendingUrl is
// undefined at that point) — too late to install a Cookie-strip DNR rule before
// the first request goes out. `webNavigation.onCreatedNavigationTarget` is
// purpose-built for exactly this tab-creation path and delivers `url`
// synchronously, closing that race.
export function registerLinkedTabInheritance(restored: Promise<void>): void {
  chrome.webNavigation.onCreatedNavigationTarget.addListener(async (details) => {
    const { sourceTabId, tabId, url } = details
    // onCreatedNavigationTarget precedes the initial onBeforeNavigate for this
    // target. Permit that one expected generation increment, but reject any
    // later navigation that starts while rule/settings storage is loading.
    const creationGeneration = getNavigationGeneration(tabId)
    await restored
    if (tabSessions[tabId] !== undefined) return // already assigned; don't clobber
    // The target's onBeforeNavigate event may increment the navigation
    // generation after this creation event, before this async handler resumes.
    // The creation event itself identifies the authoritative initial URL; allow
    // only that event's generation (or its matching onBeforeNavigate callback).
    const canAutoBind = () =>
      getNavigationGeneration(tabId) <= creationGeneration + 1 &&
      getTabBindingMeta(tabId).source !== 'manual'

    // An explicit URL rule wins over inherited opener state. This also gives
    // the first navigation the same best-effort clean-cookie setup as an
    // extension-created tab.
    const rule = await resolveRuleForUrl(url)
    if (!canAutoBind()) return
    if (rule) {
      await bindTabToProfile(tabId, rule.profileId, {
        source: 'rule',
        ruleId: rule.ruleId,
      }, { navigationUrl: url, isCurrent: canAutoBind })
      return
    }

    const settings = await getExtSettings()
    if (!canAutoBind()) return
    if (settings.autoInheritProfileForLinkedTabs === false) return

    const openerSessionId = tabSessions[sourceTabId]
    if (!openerSessionId || isInternalSession(openerSessionId)) return

    await bindTabToProfile(tabId, openerSessionId, { source: 'inherit' }, {
      navigationUrl: /^https?:/.test(url) ? url : undefined,
      isCurrent: canAutoBind,
    })
  })
}
