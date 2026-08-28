// rule-resolver.ts — Pure URL-to-Profile rule matching.

import type { ProfileRule, RuleMatch, Session } from '../lib/types.js'
import { normalizeHostname } from '../lib/rule-store.js'

export type RuleResolution = {
  profileId: string
  ruleId: string
  ruleName: string
}

type NormalizedUrl = {
  url: URL
  scheme: 'http' | 'https'
  hostname: string
  effectivePort: number
  href: string
}

function normalizeUrl(rawUrl: string): NormalizedUrl | null {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    const scheme = url.protocol === 'https:' ? 'https' : 'http'
    const hostname = normalizeHostname(url.hostname)
    const effectivePort = url.port
      ? Number(url.port)
      : scheme === 'https' ? 443 : 80
    // URL fragments never reach the server and should not change the session.
    url.hash = ''
    return { url, scheme, hostname, effectivePort, href: url.href }
  } catch {
    return null
  }
}

function matchesMatch(normalized: NormalizedUrl, match: RuleMatch): boolean {
  if (match.scheme !== normalized.scheme) return false
  if (normalizeHostname(match.hostname) !== normalized.hostname) return false
  if (match.port !== undefined && match.port !== normalized.effectivePort) return false
  if (match.urlRegex !== undefined) {
    try {
      if (!new RegExp(match.urlRegex).test(normalized.href)) return false
    } catch {
      return false
    }
  }
  return true
}

function specificity(rule: ProfileRule): number {
  // Priority is authoritative; this score only breaks equal-priority ties.
  let score = 10 + rule.match.hostname.length
  if (rule.match.port !== undefined) score += 100
  if (rule.match.urlRegex !== undefined) score += 10_000
  return score
}

/**
 * Resolve a URL against rules. Orphaned rules are deliberately ignored: their
 * data remains available for repair in the Rules UI, but a deleted Profile can
 * never become active accidentally.
 */
export function resolveProfileForUrl(
  rawUrl: string,
  rules: readonly ProfileRule[],
  profiles: readonly Session[],
): RuleResolution | null {
  const normalized = normalizeUrl(rawUrl)
  if (!normalized) return null
  const profileIds = new Set(profiles.map((profile) => profile.id))

  const candidates = rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => rule.enabled !== false)
    .filter(({ rule }) => profileIds.has(rule.profileId))
    .filter(({ rule }) => rule.match && matchesMatch(normalized, rule.match))
    .sort((left, right) => {
      const priority = (right.rule.priority ?? 100) - (left.rule.priority ?? 100)
      if (priority !== 0) return priority
      const specificityDiff = specificity(right.rule) - specificity(left.rule)
      if (specificityDiff !== 0) return specificityDiff
      return left.index - right.index
    })

  const winner = candidates[0]?.rule
  if (!winner) return null
  return { profileId: winner.profileId, ruleId: winner.id, ruleName: winner.name }
}

export function urlMatchesRule(rawUrl: string, rule: ProfileRule): boolean {
  const normalized = normalizeUrl(rawUrl)
  return normalized !== null && rule.enabled !== false && matchesMatch(normalized, rule.match)
}

export function normalizeRuleTestUrl(rawUrl: string): string | null {
  return normalizeUrl(rawUrl)?.href ?? null
}
