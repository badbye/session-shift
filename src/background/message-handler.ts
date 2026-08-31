// message-handler.ts — Handles all chrome.runtime.onMessage dispatches.

import { getCookieStore, setCookieStore, getProfiles, setProfiles, deleteSessionData, isInternalSession, duplicateSession, updateSessionHue, createSession, withProfileMutation } from '../lib/session-store.js';
import { createRule, deleteRule, getRules, setRuleEnabled, updateRule } from '../lib/rule-store.js';
import { parseProfileRulesTransfer, replaceProfileRules } from '../lib/profile-rules-transfer.js';
import { withCookieLock } from '../lib/cookie-write-lock.js';
import { serializeCookieHeader, parseCookieString, parseDocumentCookie, cookieKey, cookieMatchesRequest, defaultCookiePath, normalizeCookiePath, isValidCookieName, isValidCookieValue } from '../lib/cookie-parser.js';
import type { BackgroundMessage } from '../lib/types.js';
import { getTabBindingMeta, tabSessions, persistTabSessions, setTabBindingMeta, updateBadge } from './session-manager.js';
import { clearCookieStoreCache, updateDNRRulesForTab } from './dnr-manager.js';
import { bindTabToProfile } from './session-binding.js';
import { applyAutomaticProfileForTab, getNavigationGeneration, invalidateNavigation, refreshRuleSnapshot, restoreAutomaticProfileForTab } from './rule-manager.js';
import { getLanguagePreference, createLocalizer } from '../lib/localization.js';
import { syncProfileGroupAppearance, ungroupTab } from './tab-group-sync.js';
import { BOOTSTRAP_PRIVATE_KEY } from '../lib/bootstrap-authority.js';

type BootstrapAuthorization = {
  bootstrapToken: string
  bootstrapProof: string
  bootstrapProofPayload: string
}

let bootstrapSignerPromise: Promise<CryptoKey | null> | null = null

function getBootstrapSigner(): Promise<CryptoKey | null> {
  if (!bootstrapSignerPromise) {
    bootstrapSignerPromise = crypto.subtle.importKey(
      'jwk',
      BOOTSTRAP_PRIVATE_KEY,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    ).catch(() => null)
  }
  return bootstrapSignerPromise
}

function bytesToBase64(bytes: ArrayBuffer): string {
  let binary = ''
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

async function createBootstrapAuthorization(
  sessionId: string,
  sender: chrome.runtime.MessageSender,
  challenge?: string,
): Promise<BootstrapAuthorization | null> {
  const signer = await getBootstrapSigner()
  if (!signer) return null
  const bootstrapToken = crypto.randomUUID()
  const bootstrapProofPayload = JSON.stringify({
    sessionId,
    bootstrapToken,
    challenge: challenge ?? null,
    tabId: sender.tab?.id ?? null,
    frameId: sender.frameId ?? 0,
    documentId: sender.documentId ?? null,
  })
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signer,
    new TextEncoder().encode(bootstrapProofPayload),
  )
  return { bootstrapToken, bootstrapProof: bytesToBase64(signature), bootstrapProofPayload }
}

export async function handleMessage(
  request: BackgroundMessage,
  sender: chrome.runtime.MessageSender
): Promise<unknown> {
  switch (request.action) {
    case 'setSession': {
      const { tabId, sessionId } = request.payload;
      if (typeof tabId !== 'number' || typeof sessionId !== 'string') {
        return { error: 'invalid payload' };
      }
      if (sessionId !== 'default') {
        // Profiles are global — validate the id against the single profile list,
        // not a per-origin one. A profile created on any site is selectable here.
        const list = await getProfiles();
        if (!list.find(s => s.id === sessionId)) return { error: 'unknown session' };
      }
      let navigationUrl: string | undefined;
      try {
        const tab = await chrome.tabs.get(tabId);
        if (typeof tab?.url === 'string' && /^https?:/i.test(tab.url)) navigationUrl = tab.url;
      } catch {
        // The tab may disappear between the popup query and this message.
      }
      const generation = invalidateNavigation(tabId);
      await bindTabToProfile(tabId, sessionId, { source: 'manual' }, {
        navigationUrl,
        isCurrent: () => getNavigationGeneration(tabId) === generation,
      });
      return { success: true, sessionId };
    }

    case 'getSession': {
      const tabId = request.payload?.tabId ?? sender.tab?.id;
      if (tabId === undefined) return { sessionId: 'default' };
      const sessionId = tabSessions[tabId] || 'default';
      const meta = getTabBindingMeta(tabId);
      return { sessionId, source: meta.source, ruleId: meta.ruleId };
    }

    case 'restoreAutoMatch': {
      const { tabId } = request.payload;
      if (typeof tabId !== 'number') return { error: 'invalid payload' };
      // Remove the manual lock before resolving the current URL. The resolver
      // will install either the winning Rule or default binding.
      const generation = invalidateNavigation(tabId);
      setTabBindingMeta(tabId, { source: 'default' });
      await persistTabSessions();
      const resolution = await restoreAutomaticProfileForTab(
        tabId,
        () => getNavigationGeneration(tabId) === generation,
      );
      return { success: true, resolution };
    }

    case 'getRules': {
      return { rules: await getRules() };
    }

    case 'replaceProfileRules': {
      // Options is an untrusted extension page boundary too: validate the
      // payload again in the service worker before replacing shared storage.
      const data = parseProfileRulesTransfer(JSON.stringify(request.payload));
      await replaceProfileRules(data);
      await refreshRuleSnapshot();
      return { success: true, profiles: data.profiles.length, rules: data.rules.length };
    }

    case 'createSession': {
      const { name, hue } = request.payload;
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 200
        || (hue !== undefined && (typeof hue !== 'number' || !Number.isFinite(hue)))) {
        return { error: 'invalid payload' };
      }
      const session = await createSession(name, hue);
      return { success: true, session };
    }

    case 'renameSession': {
      const { sessionId, name } = request.payload;
      if (typeof sessionId !== 'string' || typeof name !== 'string' || !name.trim() || name.trim().length > 200) {
        return { error: 'invalid payload' };
      }
      const renamed = await withProfileMutation(async () => {
        const profiles = await getProfiles();
        const index = profiles.findIndex((profile) => profile.id === sessionId);
        if (index === -1) return null;
        const next = [...profiles];
        next[index] = { ...next[index], name: name.trim() };
        await setProfiles(next);
        return next[index];
      });
      if (!renamed) return { error: 'session not found' };
      void syncProfileGroupAppearance(sessionId).catch(() => {});
      return { success: true, session: renamed };
    }

    case 'createRule': {
      const rule = await createRule(request.payload);
      await refreshRuleSnapshot();
      return { success: true, rule };
    }

    case 'updateRule': {
      const rule = await updateRule(request.payload.rule);
      await refreshRuleSnapshot();
      return { success: true, rule };
    }

    case 'deleteRule': {
      const deleted = await deleteRule(request.payload.ruleId);
      await refreshRuleSnapshot();
      return deleted ? { success: true } : { error: 'rule not found' };
    }

    case 'setRuleEnabled': {
      const rule = await setRuleEnabled(request.payload.ruleId, request.payload.enabled);
      await refreshRuleSnapshot();
      return { success: true, rule };
    }

    case 'getSessionForBootstrap': {
      const tabId = request.payload?.tabId ?? sender.tab?.id;
      if (tabId === undefined) return { sessionId: 'default', cookieStr: '' };
      let bootstrapUrl = sender.url ?? sender.tab?.url;
      if (!bootstrapUrl) {
        try {
          bootstrapUrl = (await chrome.tabs.get(tabId))?.url;
        } catch {
          bootstrapUrl = undefined;
        }
      }
      let parsedBootstrapUrl: URL;
      try {
        parsedBootstrapUrl = new URL(bootstrapUrl ?? '');
      } catch {
        // Never send a global profile cookie store to a page whose origin is
        // unknown. The page proxy will remain fail-closed until reload.
        return { sessionId: 'default', cookieStr: '' };
      }
      if (parsedBootstrapUrl.protocol !== 'http:' && parsedBootstrapUrl.protocol !== 'https:') {
        return { sessionId: tabSessions[tabId] || 'default', cookieStr: '' };
      }
      // Resolve the destination URL in the bootstrap request itself. The
      // webNavigation callback is asynchronous and can run after the new
      // document's content script has already asked for its profile; resolving
      // here makes the session identity authoritative before page bootstrap.
      if (sender.frameId === undefined || sender.frameId === 0) {
        const navigationGeneration = getNavigationGeneration(tabId);
        const isCurrentNavigation = () => getNavigationGeneration(tabId) === navigationGeneration;
        await applyAutomaticProfileForTab(tabId, parsedBootstrapUrl.href, isCurrentNavigation);
        // A newer top-level navigation may have started while the old document
        // was waiting on profile/rule storage. Fail closed here; the newer
        // document will issue its own bootstrap request with the new generation.
        if (!isCurrentNavigation()) return { sessionId: 'default', cookieStr: '' };
      }
      const sessionId = tabSessions[tabId] || 'default';
      if (isInternalSession(sessionId)) {
        return { sessionId: 'default', cookieStr: '' };
      }
      const store = await getCookieStore(sessionId);
      const cookieStr = serializeCookieHeader(store, {
        excludeHttpOnly: true,
        excludeSecure: parsedBootstrapUrl.protocol !== 'https:',
        requestUrl: parsedBootstrapUrl.href,
      });
      const cookieEntries = Object.values(store)
        .filter((entry) =>
          !entry.httpOnly &&
          (entry.expires == null || entry.expires > Date.now()) &&
          (!entry.secure || parsedBootstrapUrl.protocol === 'https:') &&
          cookieMatchesRequest(entry, parsedBootstrapUrl.href),
        )
        .map((entry) => ({
          name: entry.name,
          value: entry.value,
          domain: entry.domain,
          path: normalizeCookiePath(entry.path),
          expires: entry.expires,
          secure: entry.secure,
          sameSite: entry.sameSite,
        }));
      const authorization = await createBootstrapAuthorization(
        sessionId,
        sender,
        request.payload?.challenge,
      );
      return { sessionId, cookieStr, cookieEntries, ...(authorization ?? {}) };
    }

    // Trust model: sessionId is derived from tabSessions[sender.tab.id] (server-side
    // authority). The cross-world nonce in page-api-proxy is defense-in-depth only;
    // do not add new trust on it.
    case 'updateCookie': {
      const { cookieStr, setCookieStr, deletedNames, deletedNamePaths, deleteTargets, expectedProfileId } = request.payload;
      const hasSet = typeof setCookieStr === 'string' || typeof cookieStr === 'string';
      const hasDelete = Array.isArray(deletedNames) || Array.isArray(deleteTargets)
        || (deletedNamePaths && typeof deletedNamePaths === 'object');
      if (!hasSet && !hasDelete) return { error: 'invalid payload' };
      const tabId = sender.tab?.id;
      if (tabId === undefined) return { error: 'no tab context' };
      const sessionId = tabSessions[tabId];
      if (!sessionId || isInternalSession(sessionId)) {
        return { success: false, reason: 'no isolated session' };
      }
      // The page can outlive a manual/rule binding change until its reload.
      // Never let that old document's queued write follow the new tab mapping
      // into a different Profile.
      if (expectedProfileId !== sessionId) {
        return { success: false, reason: 'stale profile binding' };
      }
      await withCookieLock(sessionId, async () => {
        const existing = await getCookieStore(sessionId);
        let currentUrl: URL | null = null;
        try {
          // The page controls request.payload.url because it originates in the
          // MAIN-world proxy. Use Chrome's authenticated sender context instead;
          // otherwise a forged relay could write a profile cookie for another
          // origin and make it eligible for later DNR injection.
          currentUrl = new URL(sender.url ?? sender.tab?.url ?? '');
        } catch {
          currentUrl = null;
        }
        if (!currentUrl || (currentUrl.protocol !== 'https:' && currentUrl.protocol !== 'http:')) return;
        // Domain is ALWAYS host-pinned to the document host — never page-supplied.
        // A page setting Domain=.victim.com must not widen the stored cookie's
        // domain (would emit a domain-wide DNR set-rule = cookie injection).
        const cookieDomain = currentUrl.hostname;
        const requestUrl = currentUrl.href;

        const hasHttpOnlyCookie = (name: string, path: string) =>
          Object.entries(existing).some(([key, entry]) =>
            (entry?.name ?? key) === name &&
            entry?.httpOnly &&
            normalizeCookiePath(entry.path) === path &&
            cookieMatchesRequest(entry, new URL(path, requestUrl).href)
          );

        const deleteByName = (name: string, exactPath?: string) => {
          for (const [key, entry] of Object.entries(existing)) {
            if ((entry?.name ?? key) !== name || entry?.httpOnly) continue;
            if (exactPath && normalizeCookiePath(entry.path) !== exactPath) continue;
            if (cookieMatchesRequest(entry, requestUrl)) delete existing[key];
          }
        };

        const setCookie = (name: string, value: string, path: string, expires: number | null, secure: boolean, sameSite?: string) => {
          if (hasHttpOnlyCookie(name, path)) return;
          const key = cookieKey(name, cookieDomain, path);
          existing[key] = existing[key]
            ? { ...existing[key], name, domain: cookieDomain, path, value, expires }
            : { name, domain: cookieDomain, path, value, expires, secure };
          existing[key].secure = secure;
          if (sameSite !== undefined) existing[key].sameSite = sameSite;
          if (key !== name && name in existing) delete existing[name];
        };

        // Preferred set path: full cookie string with Path/Max-Age/Expires.
        if (typeof setCookieStr === 'string') {
          const parsed = parseDocumentCookie(setCookieStr, requestUrl);
          // Authoritative validation — the nonce is defense-in-depth only.
          if (parsed && isValidCookieName(parsed.name) && isValidCookieValue(parsed.value)) {
            if (parsed.expires !== null && parsed.expires <= Date.now()) {
              if (!hasHttpOnlyCookie(parsed.name, normalizeCookiePath(parsed.path))) {
                deleteByName(parsed.name, normalizeCookiePath(parsed.path));
              }
            } else {
              setCookie(parsed.name, parsed.value, parsed.path, parsed.expires, parsed.secure, parsed.sameSite);
            }
          }
        } else if (typeof cookieStr === 'string') {
          // Legacy attribute-less path (no setCookieStr); host-pinned, session expiry.
          for (const [name, value] of parseCookieString(cookieStr)) {
            if (!isValidCookieName(name) || !isValidCookieValue(value)) continue;
            setCookie(name, value, defaultCookiePath(currentUrl.pathname), null, false);
          }
        }

        if (Array.isArray(deletedNames)) {
          for (const name of deletedNames) {
            if (typeof name !== 'string') continue;
            const exactPath = deletedNamePaths && typeof deletedNamePaths[name] === 'string'
              ? normalizeCookiePath(deletedNamePaths[name])
              : undefined;
            if (hasHttpOnlyCookie(name, exactPath ?? normalizeCookiePath(currentUrl.pathname))) continue;
            deleteByName(name, exactPath);
          }
        }

        // Structured deletes (cookieStore.delete) — match by name + optional
        // domain/path, NOT the document URL, so delete({name, path:'/admin'})
        // from /app targets the right entry.
        if (Array.isArray(deleteTargets)) {
          for (const target of deleteTargets) {
            if (typeof target?.name !== 'string') continue;
            const targetPath = typeof target.path === 'string' ? normalizeCookiePath(target.path) : null;
            const targetDomain = typeof target.domain === 'string'
              ? target.domain.replace(/^\./, '').toLowerCase() : null;

            // cookieStore.delete is still a page-origin API. A profile store is
            // global, but a page must not use the nonce-authenticated relay to
            // delete another site's cookies. Parent-domain cookies remain valid
            // targets (e.g. app.example.com may delete example.com), matching
            // the browser's domain-match semantics.
            if (targetDomain && currentUrl.hostname !== targetDomain
              && !currentUrl.hostname.endsWith(`.${targetDomain}`)) continue;

            for (const [key, entry] of Object.entries(existing)) {
              if ((entry?.name ?? key) !== target.name || entry?.httpOnly) continue;
              if (targetPath && normalizeCookiePath(entry.path) !== targetPath) continue;
              const entryDomain = (entry.domain ?? '').replace(/^\./, '').toLowerCase();
              if (targetDomain && entryDomain !== targetDomain) continue;
              if (!targetDomain && entryDomain
                && currentUrl.hostname !== entryDomain
                && !currentUrl.hostname.endsWith(`.${entryDomain}`)) continue;
              delete existing[key];
            }
          }
        }

        await setCookieStore(sessionId, existing);
      });
      clearCookieStoreCache(sessionId);
      await updateDNRRulesForTab(tabId, sessionId);
      return { success: true };
    }

    case 'refreshBadge': {
      const { tabId } = request.payload;
      if (typeof tabId !== 'number') return { error: 'invalid payload' };
      const sessionId = tabSessions[tabId] || 'default';
      await updateBadge(tabId, sessionId);
      return { success: true };
    }

    case 'deleteSession': {
      const { sessionId } = request.payload;
      if (typeof sessionId !== 'string') return { error: 'invalid payload' };
      const affectedTabIds: number[] = [];
      const deleted = await withProfileMutation(async () => {
        const profiles = await getProfiles();
        if (!profiles.some((profile) => profile.id === sessionId)) return false;
        for (const [tid, sid] of Object.entries(tabSessions)) {
          if (sid === sessionId) {
            affectedTabIds.push(Number(tid));
            delete tabSessions[tid];
            setTabBindingMeta(Number(tid), { source: 'default' });
          }
        }
        // Remove the profile before its affected tabs reload. URL-rule resolution
        // therefore observes the orphan immediately and can never reactivate it.
        await setProfiles(profiles.filter((profile) => profile.id !== sessionId));
        return true;
      });
      if (!deleted) return { error: 'session not found' };
      await deleteSessionData(sessionId);
      clearCookieStoreCache(sessionId);
      await persistTabSessions();
      for (const tid of affectedTabIds) {
        await updateDNRRulesForTab(tid, 'default');
        updateBadge(tid, 'default');
        void ungroupTab(tid).catch(() => {});
        // The page proxy keeps an in-memory cookie/storage view for the active
        // profile. Reload so the deleted profile cannot remain visible in the
        // document after network isolation has already been removed.
        chrome.tabs.reload(tid).catch(() => {});
      }
      return { success: true, affectedTabIds };
    }

    case 'createSessionTab': {
      const { url, sessionId } = request.payload;
      if (typeof url !== 'string' || typeof sessionId !== 'string') {
        return { error: 'invalid payload' };
      }
      if (!/^https?:/.test(url)) return { error: 'invalid url scheme' };
      const list = await getProfiles();
      if (!list.find(s => s.id === sessionId)) return { error: 'unknown session' };
      const newTab = await chrome.tabs.create({ url: 'about:blank', active: true });
      if (newTab.id === undefined) return { error: 'tab creation failed' };
      // Bind before navigating so the new tab has a profile and a clean-cookie
      // navigation strip in place before the first request.
      await bindTabToProfile(newTab.id, sessionId, { source: 'manual' }, { navigationUrl: url });
      await chrome.tabs.update(newTab.id, { url });
      return { success: true, tabId: newTab.id };
    }

    case 'duplicateSession': {
      const { sessionId } = request.payload ?? {};
      if (typeof sessionId !== 'string') {
        return { error: 'invalid payload' };
      }
      const localizer = await createLocalizer(await getLanguagePreference());
      const newSession = await duplicateSession(sessionId, (name) =>
        localizer.getMessage('duplicatedSessionName', [name]) || `${name} (copy)`
      );
      return { success: true, session: newSession };
    }

    case 'colorSession': {
      const { sessionId, hue } = request.payload;
      if (typeof sessionId !== 'string' || typeof hue !== 'number' || hue < 0 || hue > 360) {
        return { error: 'invalid payload' };
      }
      await updateSessionHue(sessionId, hue);
      for (const [tid, sid] of Object.entries(tabSessions)) {
        if (sid === sessionId) updateBadge(Number(tid), sessionId);
      }
      void syncProfileGroupAppearance(sessionId).catch(() => {}); // Phase 4: no-op when tab grouping is off/unpermitted
      return { success: true };
    }

    case 'renameProfileGroups': {
      const { sessionId } = request.payload;
      if (typeof sessionId !== 'string') return { error: 'invalid payload' };
      // Popup writes the new name straight to chrome.storage.local and never
      // calls into the background otherwise — this is the only path that
      // retitles a group that's already open for this profile.
      void syncProfileGroupAppearance(sessionId).catch(() => {}); // Phase 4: no-op when tab grouping is off/unpermitted
      return { success: true };
    }

    default:
      return { error: `unknown action: ${(request as { action: string }).action}` };
  }
}
