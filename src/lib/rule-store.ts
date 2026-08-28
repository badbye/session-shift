// rule-store.ts — Persistent URL routing rules.

import type { ProfileRule, RuleMatch, Session } from './types.js'
import { getProfiles } from './session-store.js'
import { withConfigMutation } from './config-mutation-queue.js'

export const RULES_KEY = 'routingRules'
export const DEFAULT_RULE_PRIORITY = 100

export type NewProfileRule = {
  name: string
  profileId: string
  match: RuleMatch
  enabled?: boolean
  priority?: number
}

// Rule mutations are read-modify-write operations on one shared storage key.
// Serialize them within the service-worker lifetime so two popup instances or
// a double-submit cannot let the later stale snapshot overwrite the earlier
// mutation. Each operation is kept in the queue even when the previous one
// failed, so one rejected write does not poison future saves.
function withRuleMutation<T>(mutation: () => Promise<T>): Promise<T> {
  return withConfigMutation(mutation)
}

export function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, '')
}

function isValidHostname(hostname: string): boolean {
  if (!hostname || /[\s/?#@]/.test(hostname)) return false
  // URL.hostname includes brackets for IPv6 in browser URL implementations.
  if (hostname.includes(':') && !/^\[[0-9a-f:.]+\]$/i.test(hostname)) return false
  try {
    const parsed = new URL(`https://${hostname}`)
    return parsed.hostname.toLowerCase() === hostname
  } catch {
    return false
  }
}

function normalizeMatch(match: RuleMatch): RuleMatch {
  const normalized: RuleMatch = {
    scheme: match.scheme,
    hostname: normalizeHostname(match.hostname),
  }
  if (match.port !== undefined) normalized.port = match.port
  if (match.urlRegex !== undefined) normalized.urlRegex = match.urlRegex
  return normalized
}

export function validateRuleFields(
  input: Pick<NewProfileRule, 'name' | 'profileId' | 'match'>
    & Partial<Pick<NewProfileRule, 'enabled' | 'priority'>>,
): void {
  if (!input || typeof input !== 'object') throw new Error('invalid rule')
  if (typeof input.name !== 'string' || !input.name.trim()) throw new Error('rule name is required')
  if (input.name.trim().length > 200) throw new Error('rule name is too long')
  if (typeof input.profileId !== 'string' || !input.profileId.trim()) {
    throw new Error('profileId is required')
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new Error('enabled must be a boolean')
  }
  if (input.priority !== undefined && (
    !Number.isInteger(input.priority) || !Number.isFinite(input.priority)
    || input.priority < -1_000_000 || input.priority > 1_000_000
  )) {
    throw new Error('priority must be an integer from -1000000 to 1000000')
  }

  const match = input.match
  if (!match || typeof match !== 'object') throw new Error('match is required')
  if (match.scheme !== 'http' && match.scheme !== 'https') {
    throw new Error('match scheme must be http or https')
  }
  if (typeof match.hostname !== 'string' || !isValidHostname(normalizeHostname(match.hostname))) {
    throw new Error('match hostname is required')
  }
  if (match.port !== undefined && (
    !Number.isInteger(match.port) || match.port < 1 || match.port > 65535
  )) {
    throw new Error('match port must be an integer from 1 to 65535')
  }
  if (match.urlRegex !== undefined) {
    if (typeof match.urlRegex !== 'string' || match.urlRegex.length > 500) {
      throw new Error('urlRegex must be a string of at most 500 characters')
    }
    try {
      // Compile at write time so navigation never encounters a malformed rule.
      // The resolver compiles again in its pure matching path for isolation from
      // mutated in-memory data.
      new RegExp(match.urlRegex)
    } catch {
      throw new Error('urlRegex is invalid')
    }
  }
}

async function assertProfileExists(profileId: string): Promise<void> {
  const profiles = await getProfiles()
  if (!profiles.some((profile) => profile.id === profileId)) {
    throw new Error('profileId does not reference an existing profile')
  }
}

export async function getRules(): Promise<ProfileRule[]> {
  const result = await chrome.storage.local.get([RULES_KEY])
  const value = result[RULES_KEY]
  return Array.isArray(value) ? value as ProfileRule[] : []
}

export async function setRules(rules: ProfileRule[]): Promise<void> {
  await chrome.storage.local.set({ [RULES_KEY]: rules })
}

export async function createRule(input: NewProfileRule): Promise<ProfileRule> {
  validateRuleFields(input)
  return withRuleMutation(async () => {
    await assertProfileExists(input.profileId)
    const rule: ProfileRule = {
      id: `rule_${crypto.randomUUID()}`,
      name: input.name.trim(),
      profileId: input.profileId,
      enabled: input.enabled ?? true,
      priority: input.priority ?? DEFAULT_RULE_PRIORITY,
      match: normalizeMatch(input.match),
    }
    const rules = await getRules()
    await setRules([...rules, rule])
    return rule
  })
}

export async function updateRule(rule: ProfileRule): Promise<ProfileRule> {
  validateRuleFields(rule)
  return withRuleMutation(async () => {
    await assertProfileExists(rule.profileId)
    const current = await getRules()
    const index = current.findIndex((item) => item.id === rule.id)
    if (index === -1) throw new Error('rule not found')

    const updated: ProfileRule = {
      ...rule,
      id: rule.id,
      name: rule.name.trim(),
      enabled: rule.enabled !== false,
      priority: Number.isFinite(rule.priority) ? rule.priority : DEFAULT_RULE_PRIORITY,
      match: normalizeMatch(rule.match),
    }
    current[index] = updated
    await setRules(current)
    return updated
  })
}

export async function deleteRule(ruleId: string): Promise<boolean> {
  if (typeof ruleId !== 'string' || !ruleId) return false
  return withRuleMutation(async () => {
    const current = await getRules()
    const next = current.filter((rule) => rule.id !== ruleId)
    if (next.length === current.length) return false
    await setRules(next)
    return true
  })
}

export async function setRuleEnabled(ruleId: string, enabled: boolean): Promise<ProfileRule> {
  return withRuleMutation(async () => {
    const current = await getRules()
    const rule = current.find((item) => item.id === ruleId)
    if (!rule) throw new Error('rule not found')
    rule.enabled = enabled === true
    await setRules(current)
    return rule
  })
}

export function isOrphanedRule(rule: ProfileRule, profiles: readonly Session[]): boolean {
  return !profiles.some((profile) => profile.id === rule.profileId)
}

export function getRuleProfileName(rule: ProfileRule, profiles: readonly Session[]): string {
  return profiles.find((profile) => profile.id === rule.profileId)?.name || 'Deleted profile'
}
