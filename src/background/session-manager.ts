// session-manager.ts — Tab→session map, badge updates, session icon generation.

import { getProfiles, isInternalSession } from '../lib/session-store.js';
import { DEFAULT_HUE, badgeBackgroundRgba, badgeTextRgba } from '../lib/profile-color.js';
import { getIconSetForHue } from './profile-icon-renderer.js';
import type { TabBindingMeta } from '../lib/types.js';

// ---------------------------------------------------------------------------
// Tab→session in-memory map (persisted to chrome.storage.session)
// ---------------------------------------------------------------------------
export let tabSessions: Record<string, string> = {};
export let tabBindingMeta: Record<string, TabBindingMeta> = {};

export async function restoreTabSessions(): Promise<void> {
  try {
    const result = await chrome.storage.session.get(['tabSessions', 'tabBindingMeta']);
    if (result.tabSessions) {
      tabSessions = result.tabSessions as Record<string, string>;
    }
    if (result.tabBindingMeta) {
      tabBindingMeta = result.tabBindingMeta as Record<string, TabBindingMeta>;
    }
  } catch (e) {
    console.warn('[bg] restoreTabSessions failed:', e);
  }
}

export async function persistTabSessions(): Promise<void> {
  try {
    await chrome.storage.session.set({ tabSessions, tabBindingMeta });
  } catch (e) {
    console.warn('[bg] persistTabSessions failed:', e);
  }
}

export function getTabBindingMeta(tabId: number): TabBindingMeta {
  const stored = tabBindingMeta[tabId];
  if (stored) return stored;
  // Existing installations only persisted tabSessions before binding metadata
  // existed. Treat those non-default assignments as manual so the first rule
  // navigation after upgrade does not unexpectedly replace a user's profile.
  return tabSessions[tabId] && !isInternalSession(tabSessions[tabId])
    ? { source: 'manual' }
    : { source: 'default' };
}

export function setTabBindingMeta(tabId: number, meta: TabBindingMeta): void {
  tabBindingMeta[tabId] = meta;
}

export function clearTabBinding(tabId: number): void {
  delete tabSessions[tabId];
  delete tabBindingMeta[tabId];
}

// ---------------------------------------------------------------------------
// Badge + per-tab colored icon
// ---------------------------------------------------------------------------
export async function updateBadge(tabId: number, sessionId: string): Promise<void> {
  if (isInternalSession(sessionId)) {
    chrome.action.setBadgeText({ text: '', tabId });
    chrome.action.setIcon({ path: {
      '16':  'icons/icon-16.png',
      '32':  'icons/icon-32.png',
      '48':  'icons/icon-48.png',
      '128': 'icons/icon-128.png',
    }, tabId }).catch(() => {});
    return;
  }

  // Badge text is capped to 3 chars by design — Chrome action badges only render
  // ~4 narrow glyphs, so the session name is truncated to a short tag.
  let label = sessionId.replace(/^session_/, '').substring(0, 3).toUpperCase();
  let hue = DEFAULT_HUE;
  try {
    // Profiles are global — look the active profile up by id, no origin needed.
    const list = await getProfiles();
    const session = list.find((s) => s.id === sessionId);
    if (session?.name) label = session.name.substring(0, 3).toUpperCase();
    if (session?.hue !== undefined) hue = session.hue;
  } catch (_) {}

  chrome.action.setBadgeBackgroundColor({ color: badgeBackgroundRgba(hue), tabId });
  // Chrome 110+. Older builds keep Chrome's default white label, which is what
  // shipped before this call existed.
  if (typeof chrome.action.setBadgeTextColor === 'function') {
    chrome.action.setBadgeTextColor({ color: badgeTextRgba(hue), tabId });
  }
  chrome.action.setBadgeText({ text: label, tabId });

  // Icon comes after the badge so a slow or failing rasterization never delays
  // or breaks the badge, which is the behavior that shipped before this.
  try {
    const imageData = await getIconSetForHue(hue);
    await chrome.action.setIcon({ imageData, tabId });
  } catch (_) {
    // Stock path icons stay in place — same degradation as the internal branch.
  }
}
