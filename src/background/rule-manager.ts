// rule-manager.ts — Apply URL rules to top-level Tab navigations.

import { getProfiles, isInternalSession } from '../lib/session-store.js'
import { getRules } from '../lib/rule-store.js'
import type { ProfileRule, Session } from '../lib/types.js'
import { resolveProfileForUrl, type RuleResolution } from './rule-resolver.js'
import { bindTabToProfile } from './session-binding.js'
import { prepareNavigationCookieStrip } from './dnr-manager.js'
import { getTabBindingMeta, persistTabSessions, setTabBindingMeta, tabSessions } from './session-manager.js'

// Shared with the document bootstrap path. A content script can ask for its
// profile while an earlier navigation is still awaiting storage; both paths
// must agree on which top-level navigation is authoritative.
const latestNavigation = new Map<number, number>()
let ruleSnapshot: { rules: ProfileRule[]; profiles: Session[] } | null = null

export function getNavigationGeneration(tabId: number): number {
  return latestNavigation.get(tabId) ?? 0
}

/** Invalidate any in-flight automatic routing for a tab. */
export function invalidateNavigation(tabId: number): number {
  const generation = getNavigationGeneration(tabId) + 1
  latestNavigation.set(tabId, generation)
  return generation
}

export async function refreshRuleSnapshot(): Promise<void> {
  const [rules, profiles] = await Promise.all([getRules(), getProfiles()])
  ruleSnapshot = { rules, profiles }
}

function peekRuleForUrl(url: string): RuleResolution | null {
  return ruleSnapshot ? resolveProfileForUrl(url, ruleSnapshot.rules, ruleSnapshot.profiles) : null
}

export async function resolveRuleForUrl(url: string): Promise<RuleResolution | null> {
  await refreshRuleSnapshot()
  return peekRuleForUrl(url)
}

/**
 * Apply automatic routing for a navigation. A manual binding is a deliberate
 * per-tab override and remains authoritative until restoreAutoMatch is called.
 * Linked-tab inheritance is also preserved when no rule matches, maintaining
 * the existing SessionShift behavior.
 */
export async function applyAutomaticProfileForTab(
  tabId: number,
  url: string,
  isCurrent: () => boolean = () => true,
): Promise<RuleResolution | null> {
  const meta = getTabBindingMeta(tabId)
  if (meta.source === 'manual') return null

  const resolution = await resolveRuleForUrl(url)
  if (!isCurrent()) return null
  // A manual selection may arrive while the rule/profile reads are in flight.
  // Re-read the authoritative binding metadata before applying the result so a
  // late resolver cannot overwrite the user's explicit choice.
  if (getTabBindingMeta(tabId).source === 'manual') return null
  if (resolution) {
    await bindTabToProfile(tabId, resolution.profileId, {
      source: 'rule',
      ruleId: resolution.ruleId,
    }, { navigationUrl: url, isCurrent })
    return resolution
  }

  // Linked-tab inheritance is an existing automatic binding mode. Re-read the
  // metadata after the async rule/profile lookup so a concurrent opener event
  // cannot be lost by the no-match fallback below.
  const latestMeta = getTabBindingMeta(tabId)
  if (latestMeta.source === 'manual') return null
  // Preserve linked-tab inheritance when the destination has no URL rule.
  // A later navigation can still be explicitly overridden by the user or by a
  // matching Rule.
  if (latestMeta.source === 'inherit') return null

  // Automatic mode must not carry an inherited or rule-selected profile into an
  // unrelated URL with no matching rule.
  if (!isCurrent()) return null
  const current = tabSessions[tabId] || 'default'
  if (!isInternalSession(current) || latestMeta.source === 'rule') {
    await bindTabToProfile(tabId, 'default', { source: 'default' }, { isCurrent })
  }
  return null
}

export async function restoreAutomaticProfileForTab(
  tabId: number,
  isCurrent: () => boolean = () => true,
): Promise<RuleResolution | null> {
  const tab = await chrome.tabs.get(tabId)
  if (!isCurrent()) return null
  const url = tab?.url
  if (typeof url !== 'string' || !/^https?:/i.test(url)) {
    await bindTabToProfile(tabId, 'default', { source: 'default' }, { isCurrent })
    return null
  }
  // Clear the manual lock before resolving the current URL.
  setTabBindingMeta(tabId, { source: 'default' })
  await persistTabSessions()
  return applyAutomaticProfileForTab(tabId, url, isCurrent)
}

export function registerRuleNavigationListener(restored: Promise<void>): void {
  void restored.then(() => refreshRuleSnapshot()).catch(() => {});
  chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
    if (details.tabId < 0 || (details.frameId !== undefined && details.frameId !== 0)) return
    const generation = invalidateNavigation(details.tabId)
    const preview = peekRuleForUrl(details.url)
    const current = tabSessions[details.tabId] || 'default'
    const currentMeta = getTabBindingMeta(details.tabId)
    if (ruleSnapshot !== null && currentMeta.source !== 'manual') {
      // Preflight only when the cached resolver proves that the destination's
      // Profile context will change. Installing a strip for every reload or
      // same-Profile navigation would replace working Cookie-set rules before
      // the async resolver republishes them, making authenticated pages appear
      // logged out on their first request.
      const profileWillChange = preview
        ? current !== preview.profileId
        : !isInternalSession(current)
      if (profileWillChange) prepareNavigationCookieStrip(details.tabId, details.url)
    }
    await restored
    try {
      if (latestNavigation.get(details.tabId) !== generation) return
      const latestSession = tabSessions[details.tabId] || 'default'
      const latestMeta = getTabBindingMeta(details.tabId)
      if (latestMeta.source === 'manual') {
        if (!isInternalSession(latestSession)) {
          await bindTabToProfile(details.tabId, latestSession, latestMeta, {
            navigationUrl: details.url,
            isCurrent: () => latestNavigation.get(details.tabId) === generation,
          })
        }
        return
      }
      await applyAutomaticProfileForTab(
        details.tabId,
        details.url,
        () => latestNavigation.get(details.tabId) === generation,
      )
      // A later navigation may have superseded this resolver while it awaited
      // storage. Do not let a stale result remain authoritative.
      if (latestNavigation.get(details.tabId) !== generation) return
    } catch (error) {
      console.warn('[bg] rule navigation failed:', error)
    }
  })
}
