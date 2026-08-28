import { describe, expect, it } from 'vitest'
import {
  createRule,
  getRuleProfileName,
  getRules,
  isOrphanedRule,
  setRules,
  updateRule,
} from '../lib/rule-store.js'
import { setProfiles } from '../lib/session-store.js'

describe('rule-store', () => {
  it('creates a normalized rule with defaults and generated id', async () => {
    await setProfiles([{ id: 'p1', name: 'Dev' }])
    const created = await createRule({
      name: 'Dev site',
      profileId: 'p1',
      match: { scheme: 'HTTPS'.toLowerCase(), hostname: ' Example.COM. ', port: undefined },
    })
    expect(created.id).toMatch(/^rule_/)
    expect(created.enabled).toBe(true)
    expect(created.priority).toBe(100)
    expect(created.match.hostname).toBe('example.com')
  })

  it('rejects missing profile references and invalid optional fields', async () => {
    await setProfiles([{ id: 'p1', name: 'Dev' }])
    await expect(createRule({
      name: 'orphan', profileId: 'deleted', match: { scheme: 'https', hostname: 'example.com' },
    })).rejects.toThrow('profileId')
    await expect(createRule({
      name: 'bad-port', profileId: 'p1', match: { scheme: 'https', hostname: 'example.com', port: 0 },
    })).rejects.toThrow('port')
    await expect(createRule({
      name: 'bad-regex', profileId: 'p1', match: { scheme: 'https', hostname: 'example.com', urlRegex: '[' },
    })).rejects.toThrow('urlRegex')
  })

  it('keeps orphaned rules after their profile disappears', async () => {
    const orphan = {
      id: 'rule_orphan',
      name: 'Former Dev',
      profileId: 'deleted-profile',
      enabled: true,
      priority: 100,
      match: { scheme: 'https', hostname: 'example.com' },
    }
    await setRules([orphan])
    await setProfiles([])
    const rules = await getRules()
    expect(rules).toEqual([orphan])
    expect(isOrphanedRule(orphan, [])).toBe(true)
    expect(getRuleProfileName(orphan, [])).toBe('Deleted profile')
  })

  it('can repair an orphaned rule by assigning an existing profile', async () => {
    await setProfiles([{ id: 'p2', name: 'Production' }])
    await setRules([{
      id: 'rule_repair', name: 'Repair', profileId: 'deleted', enabled: true, priority: 100,
      match: { scheme: 'https', hostname: 'example.com' },
    }])
    const repaired = await updateRule({
      id: 'rule_repair', name: 'Repair', profileId: 'p2', enabled: true, priority: 100,
      match: { scheme: 'https', hostname: 'example.com' },
    })
    expect(repaired.profileId).toBe('p2')
    expect(isOrphanedRule(repaired, [{ id: 'p2', name: 'Production' }])).toBe(false)
  })
})
