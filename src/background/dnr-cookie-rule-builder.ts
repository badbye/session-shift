import { serializeCookieHeader, normalizeCookiePath, cookieMatchesRequest, type SerializeOptions } from '../lib/cookie-parser.js';
import type { CookieStoreEntry } from '../lib/session-store.js';
import type { DNRRule } from '../lib/types.js';
import { getEtld1 } from '../lib/public-suffix.js';

type CookieRuleScope = {
  type: 'host' | 'domain'
  host: string
  path: string
}

type CookieRequestScheme = 'http' | 'https' | 'ws' | 'wss'

type BuildRuleOptions = {
  tabId: number
  ruleIds: number[]
  boundHost: string | null
  scheme: 'https' | 'http' | null
  store: Record<string, CookieStoreEntry>
  serializeOpts: SerializeOptions
  resourceTypes: chrome.declarativeNetRequest.ResourceType[]
  firstPartyDomain?: string | null
  requestStripResourceTypes?: chrome.declarativeNetRequest.ResourceType[]
  responseStripResourceTypes?: chrome.declarativeNetRequest.ResourceType[]
  bridgeNavigationUrl?: string | null
}

function normalizeStoredDomain(domain: string | null | undefined, boundHost: string | null): string | null {
  return (domain ?? boundHost)?.replace(/\.$/, '').toLowerCase() ?? null;
}

function pathFilterSuffix(path: string): string {
  if (path === '/') return '/';
  return path.endsWith('/') ? path : `${path}^`;
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function exactHostRegexFilter(scheme: CookieRequestScheme, host: string, path: string): string {
  const hostPattern = escapeRegex(host);
  if (path === '/') return `^${scheme}://${hostPattern}(?::[0-9]+)?/`;
  const pathPattern = escapeRegex(path);
  return `^${scheme}://${hostPattern}(?::[0-9]+)?${pathPattern}(?:[/?#]|$)`;
}

function domainUrlFilter(scheme: CookieRequestScheme, path: string): string {
  if (path === '/') return `|${scheme}://`;
  return `|${scheme}://*${pathFilterSuffix(path)}`;
}

function addPath(pathsByHost: Map<string, Set<string>>, host: string, path: string): void {
  pathsByHost.set(host, (pathsByHost.get(host) ?? new Set()).add(path));
}

function buildCookieRuleScopes(store: Record<string, CookieStoreEntry>, boundHost: string | null): CookieRuleScope[] {
  const exactHosts = new Set<string>();
  const pathsByHost = new Map<string, Set<string>>();
  const pathsByDomain = new Map<string, Set<string>>();

  if (boundHost) exactHosts.add(boundHost.toLowerCase());

  for (const entry of Object.values(store)) {
    const domain = normalizeStoredDomain(entry.domain, boundHost);
    if (!domain) continue;
    const path = normalizeCookiePath(entry.path);
    const domainWithoutDot = domain.replace(/^\./, '');

    if (domain.startsWith('.')) {
      addPath(pathsByDomain, domainWithoutDot, path);
      for (const host of exactHosts) {
        if (host === domainWithoutDot || host.endsWith('.' + domainWithoutDot)) addPath(pathsByHost, host, path);
      }
    } else {
      exactHosts.add(domain);
      addPath(pathsByHost, domain, path);
    }
  }

  for (const host of exactHosts) {
    for (const [domain, paths] of pathsByDomain) {
      if (host === domain || host.endsWith('.' + domain)) {
        for (const path of paths) addPath(pathsByHost, host, path);
      }
    }
  }

  const scopes: CookieRuleScope[] = [];
  for (const [host, paths] of pathsByHost) {
    for (const path of paths) scopes.push({ type: 'host', host, path });
  }
  for (const [host, paths] of pathsByDomain) {
    for (const path of paths) scopes.push({ type: 'domain', host, path });
  }
  // Shortest paths first: when the rule budget is exhausted, deeper-path scopes
  // are dropped before root scopes. A dropped deep-path scope still matches its
  // shorter-path rule (minus path-specific cookies); a dropped root scope would
  // leave root requests with no Cookie header at all. Rule matching uses
  // per-rule priority, not this order, so selection order is safe to change.
  return scopes.sort((left, right) =>
    left.path.length - right.path.length ||
    (left.type === right.type ? left.host.localeCompare(right.host) : left.type === 'host' ? -1 : 1)
  );
}

// Bound-host-scoped condition: matches only requests to the session's eTLD+1.
function boundHostCondition(
  boundHost: string,
  scheme: 'https' | 'http' | null,
  resourceTypes: chrome.declarativeNetRequest.ResourceType[]
): chrome.declarativeNetRequest.RuleCondition {
  if (scheme) {
    return { urlFilter: `|${scheme}://`, requestDomains: [getEtld1(boundHost)], resourceTypes };
  }
  return { requestDomains: [getEtld1(boundHost)], resourceTypes };
}

// Request-side `Cookie: remove` condition.
// For global profiles this is tab-scoped, all schemes, no requestDomains. An
// http/ws subresource in an https-bound tab must also be stripped or the default
// jar leaks.
function buildRequestStripCondition(
  boundHost: string | null,
  scheme: 'https' | 'http' | null,
  resourceTypes: chrome.declarativeNetRequest.ResourceType[],
  firstPartyDomain: string | null | undefined
): chrome.declarativeNetRequest.RuleCondition {
  if (!boundHost) {
    void firstPartyDomain;
    return { resourceTypes };
  }
  return boundHostCondition(boundHost, scheme, resourceTypes);
}

// Response-side `set-cookie: remove` condition. The caller controls resource
// types so navigation and subresource responses can both be kept out of the
// shared jar while webRequest captures the original header for the profile.
function buildResponseStripCondition(
  boundHost: string | null,
  scheme: 'https' | 'http' | null,
  resourceTypes: chrome.declarativeNetRequest.ResourceType[]
): chrome.declarativeNetRequest.RuleCondition {
  if (!boundHost) {
    return { resourceTypes };
  }
  return boundHostCondition(boundHost, scheme, resourceTypes);
}

function buildCookieCondition(
  scope: CookieRuleScope,
  scheme: CookieRequestScheme | null,
  resourceTypes: chrome.declarativeNetRequest.ResourceType[]
): chrome.declarativeNetRequest.RuleCondition {
  if (scheme && scope.type === 'host') {
    return { regexFilter: exactHostRegexFilter(scheme, scope.host, scope.path), resourceTypes };
  }
  if (scheme) {
    return {
      urlFilter: domainUrlFilter(scheme, scope.path),
      requestDomains: [scope.host],
      resourceTypes,
    };
  }
  return { requestDomains: [scope.host], resourceTypes };
}

function cookieRequestSchemes(
  options: BuildRuleOptions,
): CookieRequestScheme[] {
  if (options.boundHost) return [options.scheme ?? 'https'];
  // A Profile is global, so its cookies may be needed by a subresource whose
  // scheme differs from the top-level tab (for example https API calls from an
  // http page). WebSocket URLs use ws/wss and are otherwise still covered by
  // the tab-wide Cookie strip, so include those variants whenever websocket
  // requests are in the rule set.
  const schemes: CookieRequestScheme[] = ['http', 'https'];
  if (options.resourceTypes.some((type) => String(type) === 'websocket')) schemes.push('ws', 'wss');
  return schemes;
}

function allowsSecureCookies(scheme: CookieRequestScheme, host?: string): boolean {
  return scheme === 'https' || scheme === 'wss'
    || (scheme === 'http' && host?.toLowerCase() === 'localhost');
}

export function buildBridgeNavigationStripCondition(
  bridgeNavigationUrl: string
): chrome.declarativeNetRequest.RuleCondition | null {
  try {
    const url = new URL(bridgeNavigationUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const exactUrl = `${url.origin}${url.pathname}${url.search}`;
    return {
      regexFilter: `^${escapeRegex(exactUrl)}$`,
      resourceTypes: ['main_frame', 'sub_frame'],
    };
  } catch {
    return null;
  }
}

export function buildDnrRulesForCookieStore(options: BuildRuleOptions): DNRRule[] {
  // Split the legacy combined rule so request and response sides can scope
  // independently. Request-side stripping is tab-scoped for every request so
  // the shared jar never competes with an isolated cookie; response-side
  // stripping covers every resource type; the auth bridge handles the timing gap
  // between capture and the next navigation.
  const requestStripResourceTypes = options.requestStripResourceTypes ?? options.resourceTypes;
  const requestCondition = buildRequestStripCondition(
    options.boundHost, options.scheme, requestStripResourceTypes, options.firstPartyDomain);
  requestCondition.tabIds = [options.tabId];
  const strictResponseResourceTypes = options.responseStripResourceTypes ?? options.resourceTypes;

  const addRules: DNRRule[] = [
    {
      id: options.ruleIds[0],
      priority: 100,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Cookie', operation: 'remove' }] },
      condition: requestCondition,
    },
  ];

  if (strictResponseResourceTypes.length > 0) {
    const responseCondition = buildResponseStripCondition(
      options.boundHost, options.scheme, strictResponseResourceTypes);
    responseCondition.tabIds = [options.tabId];
    addRules.push({
      id: options.ruleIds[addRules.length],
      priority: 100,
      action: { type: 'modifyHeaders', responseHeaders: [{ header: 'set-cookie', operation: 'remove' }] },
      condition: responseCondition,
    });
  }

  if (options.bridgeNavigationUrl) {
    const bridgeNavigationCondition = buildBridgeNavigationStripCondition(options.bridgeNavigationUrl);
    if (bridgeNavigationCondition) {
      bridgeNavigationCondition.tabIds = [options.tabId];
      addRules.push({
        id: options.ruleIds[addRules.length],
        priority: 1000,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Cookie', operation: 'remove' }] },
        condition: bridgeNavigationCondition,
      });
    }
  }

  const scopes = buildCookieRuleScopes(options.store, options.boundHost);
  for (let i = 0; i < scopes.length; i++) {
    const scope = scopes[i];
    if (addRules.length >= options.ruleIds.length) {
      // Budget exhausted: deeper-path scopes are dropped (shortest-path-first sort
      // makes this safe — root rules survive). Surface it so a user hitting the cap
      // can diagnose missing cookies on deep paths.
      console.warn(
        `[dnr] rule budget (${options.ruleIds.length}) exhausted for tab ${options.tabId}; ` +
        `${scopes.length - i} cookie scope(s) dropped`,
      );
      break;
    }
    for (const requestScheme of cookieRequestSchemes(options)) {
      const requestUrl = `${requestScheme}://${scope.host}${scope.path}`;
      const requestSerializeOpts = {
        ...options.serializeOpts,
        // The top-level tab scheme is not enough: an http page may call an
        // https API, and wss is the secure counterpart of ws.
        excludeSecure: !allowsSecureCookies(requestScheme, scope.host),
        requestUrl,
      };
      const matchingStoreEntries = Object.entries(options.store).filter(([, entry]) =>
        cookieMatchesRequest(entry, requestUrl));
      const matchingEntries = matchingStoreEntries.map(([, entry]) => entry);
      const noneEntries = matchingStoreEntries.filter(([, entry]) =>
        (entry.sameSite ?? 'lax').toLowerCase() === 'none');
      const protectedEntries = matchingStoreEntries.filter(([, entry]) =>
        (entry.sameSite ?? 'lax').toLowerCase() !== 'none');
      const protectedCookieStr = serializeCookieHeader(
        Object.fromEntries(protectedEntries), requestSerializeOpts);
      const noneCookieStr = serializeCookieHeader(
        Object.fromEntries(noneEntries), requestSerializeOpts);
      if (!protectedCookieStr && !noneCookieStr) continue;

      const sameSiteProtected = matchingEntries.some((entry) =>
        (entry.sameSite ?? 'lax').toLowerCase() !== 'none');
      const navigationStore = Object.fromEntries(
        matchingStoreEntries.filter(([, entry]) =>
          ['none', 'lax'].includes((entry.sameSite ?? 'lax').toLowerCase())),
      );
      const supportsTopLevelNavigation = options.resourceTypes.some((type) => String(type) === 'main_frame');
      const navigationCookieStr = supportsTopLevelNavigation && requestScheme !== 'ws' && requestScheme !== 'wss' && sameSiteProtected
        ? serializeCookieHeader(navigationStore, requestSerializeOpts)
        : '';
      const ruleCount = (protectedCookieStr ? 1 : 0) + (noneCookieStr ? 1 : 0) + (navigationCookieStr ? 1 : 0);
      if (addRules.length + ruleCount > options.ruleIds.length) {
        console.warn(
          `[dnr] rule budget (${options.ruleIds.length}) exhausted for tab ${options.tabId}; ` +
          `${scopes.length - i} cookie scope(s) dropped`,
        );
        return addRules;
      }

      const priority = 100 + scope.path.length * 2 + (scope.type === 'host' ? 1 : 0);
      // Keep the same-site and top-level-navigation rules disjoint on
      // main_frame. Chrome can reject/ignore overlapping Cookie `set` rules when
      // both are eligible for the same request; the navigation rule is the sole
      // owner of Lax/unspecified top-level navigation injection.
      const sameSiteResourceTypes = navigationCookieStr
        ? options.resourceTypes.filter((type) => type !== 'main_frame')
        : options.resourceTypes;
      const addCookieRule = (
        value: string,
        initiatorDomains?: string[],
        excludedInitiatorDomains?: string[],
      ) => {
        if (!value) return;
        const condition = buildCookieCondition(scope, requestScheme, sameSiteResourceTypes);
        if (initiatorDomains) condition.initiatorDomains = initiatorDomains;
        if (excludedInitiatorDomains) condition.excludedInitiatorDomains = excludedInitiatorDomains;
        condition.tabIds = [options.tabId];
        addRules.push({
          id: options.ruleIds[addRules.length],
          priority,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'Cookie', operation: 'set', value }],
          },
          condition,
        });
      };
      if (sameSiteProtected) {
        // Same-site requests need BOTH subsets in one header mutation. A pair
        // of same-priority `Cookie: set` rules would compete in DNR and Chrome
        // may choose one value, dropping the other subset.
        const sameSiteCookieStr = serializeCookieHeader(
          Object.fromEntries(matchingStoreEntries), requestSerializeOpts);
        addCookieRule(sameSiteCookieStr, [getEtld1(scope.host)]);
        // SameSite=None remains available cross-site, but is excluded from the
        // same-site rule's initiator domain so the two mutations are disjoint.
        addCookieRule(noneCookieStr, undefined, [getEtld1(scope.host)]);
      } else {
        // A scope containing only SameSite=None has no competing protected
        // subset, so one unrestricted rule is sufficient.
        addCookieRule(noneCookieStr);
      }

      // Lax (including legacy cookies with no SameSite attribute) is allowed on
      // top-level cross-site navigation. Keep this separate from the same-site
      // rule so address-bar and extension-created navigations do not need an
      // initiator domain, while Strict cookies remain withheld cross-site.
      if (navigationCookieStr) {
        const navigationCondition = buildCookieCondition(
          scope,
          requestScheme,
          ['main_frame'] as chrome.declarativeNetRequest.ResourceType[],
        );
        navigationCondition.tabIds = [options.tabId];
        addRules.push({
          id: options.ruleIds[addRules.length],
          priority,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'Cookie', operation: 'set', value: navigationCookieStr }],
          },
          condition: navigationCondition,
        });
      }
    }
  }

  return addRules;
}
