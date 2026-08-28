// profile-rules-transfer.ts — Versioned import/export for Profile metadata
// and URL Rules. Cookie and page-storage data intentionally stays local.

import type { ProfileRule, RuleMatch, Session } from './types.js'
import { getProfiles } from './session-store.js'
import { getRules, normalizeHostname, validateRuleFields, RULES_KEY } from './rule-store.js'
import { withConfigMutation } from './config-mutation-queue.js'

export const PROFILE_RULES_EXPORT_VERSION = 1 as const

export type ProfileRulesTransfer = {
  version: typeof PROFILE_RULES_EXPORT_VERSION
  profiles: Session[]
  rules: ProfileRule[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(path: string): never {
  throw new Error(`Invalid Profile/Rules JSON: ${path}`)
}

function requiredString(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) invalid(path)
  return value
}

function normalizeImportedProfile(value: unknown, index: number): Session {
  if (!isRecord(value)) invalid(`profiles[${index}] must be an object`)
  const id = requiredString(value.id, `profiles[${index}].id`, 200)
  const name = requiredString(value.name, `profiles[${index}].name`, 200)
  if ('hue' in value && (typeof value.hue !== 'number' || !Number.isFinite(value.hue))) {
    invalid(`profiles[${index}].hue must be a finite number`)
  }
  return {
    id,
    name: name.trim(),
    ...(value.hue === undefined ? {} : { hue: value.hue as number }),
  }
}

function normalizeImportedRule(value: unknown, index: number): ProfileRule {
  if (!isRecord(value)) invalid(`rules[${index}] must be an object`)
  const id = requiredString(value.id, `rules[${index}].id`, 200)
  const name = requiredString(value.name, `rules[${index}].name`, 200)
  const profileId = requiredString(value.profileId, `rules[${index}].profileId`, 200)
  if (typeof value.enabled !== 'boolean') invalid(`rules[${index}].enabled must be a boolean`)
  if (typeof value.priority !== 'number' || !Number.isInteger(value.priority)) {
    invalid(`rules[${index}].priority must be an integer`)
  }
  if (!isRecord(value.match)) invalid(`rules[${index}].match must be an object`)

  const match = value.match as Partial<RuleMatch>
  const candidate = {
    name,
    profileId,
    match: match as RuleMatch,
    enabled: value.enabled,
    priority: value.priority,
  }
  try {
    // This validates rule fields without requiring profileId to resolve. An
    // orphan rule is valid transfer data and must remain repairable after a
    // Profile is removed or omitted from an import.
    validateRuleFields(candidate)
  } catch {
    invalid(`rules[${index}] contains invalid rule fields`)
  }

  return {
    id,
    name: name.trim(),
    profileId,
    enabled: value.enabled,
    priority: value.priority,
    match: {
      scheme: match.scheme as 'http' | 'https',
      hostname: normalizeHostname(match.hostname as string),
      ...(match.port === undefined ? {} : { port: match.port }),
      ...(match.urlRegex === undefined ? {} : { urlRegex: match.urlRegex }),
    },
  }
}

function assertUniqueIds(items: readonly { id: string }[], path: string): void {
  const ids = new Set<string>()
  items.forEach((item, index) => {
    if (ids.has(item.id)) invalid(`${path}[${index}].id is duplicated`)
    ids.add(item.id)
  })
}

export function parseProfileRulesTransfer(json: string): ProfileRulesTransfer {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    invalid('file is not valid JSON')
  }
  if (!isRecord(value)) invalid('root must be an object')
  if (value.version !== PROFILE_RULES_EXPORT_VERSION) invalid(`version must be ${PROFILE_RULES_EXPORT_VERSION}`)
  if (!Array.isArray(value.profiles)) invalid('profiles must be an array')
  if (!Array.isArray(value.rules)) invalid('rules must be an array')

  const profiles = value.profiles.map(normalizeImportedProfile)
  const rules = value.rules.map(normalizeImportedRule)
  assertUniqueIds(profiles, 'profiles')
  assertUniqueIds(rules, 'rules')
  return { version: PROFILE_RULES_EXPORT_VERSION, profiles, rules }
}

export function serializeProfileRulesTransfer(
  profiles: readonly Session[],
  rules: readonly ProfileRule[],
): string {
  return JSON.stringify({
    version: PROFILE_RULES_EXPORT_VERSION,
    profiles: profiles.map(({ id, name, hue }) => ({
      id,
      name,
      ...(hue === undefined ? {} : { hue }),
    })),
    rules: rules.map(({ id, name, profileId, enabled, priority, match }) => ({
      id,
      name,
      profileId,
      enabled,
      priority,
      match: {
        scheme: match.scheme,
        hostname: match.hostname,
        ...(match.port === undefined ? {} : { port: match.port }),
        ...(match.urlRegex === undefined ? {} : { urlRegex: match.urlRegex }),
      },
    })),
  }, null, 2)
}

export async function exportProfileRules(): Promise<string> {
  const [profiles, rules] = await Promise.all([getProfiles(), getRules()])
  return serializeProfileRulesTransfer(profiles, rules)
}

/** Replace both configuration collections in one storage write. */
export async function replaceProfileRules(data: ProfileRulesTransfer): Promise<void> {
  const validated = parseProfileRulesTransfer(JSON.stringify(data))
  await withConfigMutation(() => chrome.storage.local.set({
    profiles: validated.profiles,
    [RULES_KEY]: validated.rules,
  }))
}
