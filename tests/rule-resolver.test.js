import { describe, expect, it } from 'vitest'
import { resolveProfileForUrl, urlMatchesRule } from '../background/rule-resolver.js'

const profiles = [
  { id: 'p-dev', name: 'Development' },
  { id: 'p-prod', name: 'Production' },
]

function rule(id, profileId, overrides = {}) {
  return {
    id,
    name: id,
    profileId,
    enabled: true,
    priority: 100,
    match: { scheme: 'https', hostname: 'example.com' },
    ...overrides,
  }
}

describe('resolveProfileForUrl', () => {
  it('matches scheme and hostname and treats an omitted port as any port', () => {
    const rules = [rule('dev', 'p-dev')]
    expect(resolveProfileForUrl('https://example.com:8443/app#fragment', rules, profiles)?.profileId).toBe('p-dev')
    expect(resolveProfileForUrl('http://example.com/app', rules, profiles)).toBeNull()
  })

  it('matches explicit default and custom ports correctly', () => {
    const rules = [
      rule('https-default', 'p-dev', { match: { scheme: 'https', hostname: 'example.com', port: 443 } }),
      rule('custom', 'p-prod', { match: { scheme: 'https', hostname: 'example.com', port: 8443 } }),
    ]
    expect(resolveProfileForUrl('https://example.com/', rules, profiles)?.ruleId).toBe('https-default')
    expect(resolveProfileForUrl('https://example.com:8443/', rules, profiles)?.ruleId).toBe('custom')
    expect(resolveProfileForUrl('https://example.com:9443/', rules, profiles)).toBeNull()
  })

  it('uses priority, then specificity, then stable order', () => {
    const rules = [
      rule('broad', 'p-dev', { priority: 100 }),
      rule('specific', 'p-prod', { priority: 100, match: { scheme: 'https', hostname: 'example.com', port: 8443 } }),
    ]
    expect(resolveProfileForUrl('https://example.com:8443/', rules, profiles)?.ruleId).toBe('specific')
    rules[0].priority = 200
    expect(resolveProfileForUrl('https://example.com:8443/', rules, profiles)?.ruleId).toBe('broad')
  })

  it('requires a valid profile and ignores disabled/orphaned rules', () => {
    const rules = [
      rule('orphan', 'deleted'),
      rule('off', 'p-dev', { enabled: false }),
    ]
    expect(resolveProfileForUrl('https://example.com/', rules, profiles)).toBeNull()
  })

  it('combines regex with structured fields and excludes URL fragments', () => {
    const matching = rule('path', 'p-dev', {
      match: { scheme: 'https', hostname: 'example.com', urlRegex: '^https://example\\.com/admin(?:/|$)' },
    })
    expect(urlMatchesRule('https://example.com/admin#other', matching)).toBe(true)
    expect(urlMatchesRule('https://example.com/public', matching)).toBe(false)
  })
})
