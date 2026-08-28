// session-binding.ts — One authoritative path for assigning a Profile to a Tab.

import type { TabBindingMeta } from '../lib/types.js'
import { getCookieStore, isInternalSession } from '../lib/session-store.js'
import { cookieMatchesRequest } from '../lib/cookie-parser.js'
import { clearBridgeNavigationStrip, stripCookiesOnNextNavigation, updateDNRRulesForTab } from './dnr-manager.js'
import {
  getTabBindingMeta,
  persistTabSessions,
  setTabBindingMeta,
  tabSessions,
  updateBadge,
} from './session-manager.js'
import { syncTabToGroup, ungroupTab } from './tab-group-sync.js'

export type BindTabOptions = {
  navigationUrl?: string
  /**
   * Optional cancellation predicate for async navigation work. Callers that
   * resolve a URL against a navigation generation use this to prevent a late
   * bind from publishing rules after a newer navigation or manual selection
   * has superseded it.
   */
  isCurrent?: () => boolean
}

// A tab can receive a rule result, a linked-tab inheritance result, and a
// manual selection in very close succession. Keep the authoritative bind
// effects ordered per tab so an older async operation cannot finish after a
// newer one and leave DNR rules behind for the wrong profile.
const bindingQueues = new Map<number, Promise<void>>()

async function hasUsableCookieForNavigation(profileId: string, navigationUrl: string): Promise<boolean> {
  let url: URL
  try {
    url = new URL(navigationUrl)
  } catch {
    return false
  }
  const store = await getCookieStore(profileId)
  const now = Date.now()
  // SameSite eligibility depends on the navigation initiator, which is not
  // available in this bind path. Count Strict cookies as profile coverage: the
  // generated DNR rules still gate them to same-site initiators, while the
  // base Cookie-strip prevents the browser's shared jar from leaking on
  // cross-site navigations.
  return Object.values(store).some((entry) =>
    (entry.expires == null || entry.expires > now) &&
    (!entry.secure || url.protocol === 'https:') &&
    cookieMatchesRequest(entry, url.href)
  )
}

export function bindTabToProfile(
  tabId: number,
  profileId: string,
  meta: TabBindingMeta,
  options: BindTabOptions = {},
): Promise<void> {
  const previous = bindingQueues.get(tabId) ?? Promise.resolve()
  const operation = previous.catch(() => {}).then(() => performBindTabToProfile(tabId, profileId, meta, options))
  const tracked = operation.finally(() => {
    if (bindingQueues.get(tabId) === tracked) bindingQueues.delete(tabId)
  })
  bindingQueues.set(tabId, tracked)
  return tracked
}

async function performBindTabToProfile(
  tabId: number,
  profileId: string,
  meta: TabBindingMeta,
  options: BindTabOptions,
): Promise<void> {
  if (options.isCurrent && !options.isCurrent()) return
  const previousProfileId = tabSessions[tabId]
  const previousMeta = getTabBindingMeta(tabId)

  // A high-priority one-shot strip is only needed when the target Profile has
  // no cookie that can be injected for this navigation. If it does have one,
  // the normal profile set-rules must be allowed to win so a manual switch or
  // a matching Rule does not reload the user as logged out.
  if (options.navigationUrl && !isInternalSession(profileId)) {
    if (await hasUsableCookieForNavigation(profileId, options.navigationUrl)) {
      if (options.isCurrent && !options.isCurrent()) return
      // A preflight strip may have replaced the old rule set while the target
      // profile was being resolved. Let the target cookie-set rules win.
      clearBridgeNavigationStrip(tabId)
    } else {
      if (options.isCurrent && !options.isCurrent()) return
      stripCookiesOnNextNavigation(tabId, options.navigationUrl)
    }
  }

  // A rule navigation is observed before chrome.tabs.get(tabId).url advances.
  // Pass the destination explicitly so the first DNR publish uses its scheme.
  if (options.isCurrent && !options.isCurrent()) return
  // Keep the old mapping authoritative until the target rules are installed.
  // This prevents requests in the transition window from being attributed to
  // the new profile while they are still carrying the old profile's DNR rules.
  await updateDNRRulesForTab(
    tabId,
    profileId,
    options.navigationUrl,
    undefined,
    previousProfileId ?? null,
  )
  if (options.isCurrent && !options.isCurrent()) return
  // A profile deletion or another authoritative lifecycle path may have
  // changed the mapping while DNR was being rebuilt. Do not expose this bind
  // unless the mapping that DNR replaced is still the one we observed.
  if (tabSessions[tabId] !== previousProfileId) return
  tabSessions[tabId] = profileId
  setTabBindingMeta(tabId, meta)
  await persistTabSessions()
  if (options.isCurrent && !options.isCurrent()) return
  updateBadge(tabId, profileId)

  if (isInternalSession(profileId)) {
    if (previousProfileId && !isInternalSession(previousProfileId)) {
      void ungroupTab(tabId).catch(() => {})
    }
    return
  }

  if (!isInternalSession(profileId)) {
    // A same-profile rule refresh still needs to tell the page proxy about the
    // binding source only when the actual profile changes. The source is UI
    // metadata and does not require a bootstrap reset.
    // For an automatic navigation, this message would target the old
    // document. Its sender.url is still the previous page, so the bootstrap
    // handler could resolve the old URL and rebind the tab back to the old
    // Rule while the new document is loading. The new document performs its
    // own authoritative bootstrap with its destination URL. Manual binds are
    // different: they intentionally update the currently loaded document.
    const shouldNotifyCurrentDocument = !options.navigationUrl || meta.source === 'manual'
    if (shouldNotifyCurrentDocument && (previousProfileId !== profileId || previousMeta.source !== meta.source || previousMeta.ruleId !== meta.ruleId)) {
      await chrome.tabs.sendMessage(tabId, { action: 'sessionBootstrapChanged' }).catch(() => null)
    }
    try {
      const tab = await chrome.tabs.get(tabId)
      if (tab.windowId !== undefined) void syncTabToGroup(tabId, tab.windowId, profileId).catch(() => {})
    } catch {
      // The tab may have closed between navigation and binding.
    }
  }
}
