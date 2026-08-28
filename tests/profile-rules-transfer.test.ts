import { describe, expect, it } from 'vitest'
import {
  exportProfileRules,
  parseProfileRulesTransfer,
  replaceProfileRules,
  serializeProfileRulesTransfer,
} from '../src/lib/profile-rules-transfer.js'

describe('profile-rules-transfer', () => {
  it('exports Profiles and Rules together without session data', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'p1', name: 'Dev', hue: 212 }],
      routingRules: [{
        id: 'r1', name: 'Dev rule', profileId: 'p1', enabled: true, priority: 100,
        match: { scheme: 'https', hostname: 'dev.example.com' },
      }],
      cookies_p1: { sid: { value: 'secret' } },
    })

    const parsed = JSON.parse(await exportProfileRules())
    expect(parsed).toEqual({
      version: 1,
      profiles: [{ id: 'p1', name: 'Dev', hue: 212 }],
      rules: [{
        id: 'r1', name: 'Dev rule', profileId: 'p1', enabled: true, priority: 100,
        match: { scheme: 'https', hostname: 'dev.example.com' },
      }],
    })
    expect(parsed.cookies_p1).toBeUndefined()
  })

  it('validates before replacing both configuration collections and preserves orphan rules', async () => {
    const data = parseProfileRulesTransfer(serializeProfileRulesTransfer(
      [{ id: 'p2', name: 'Production' }],
      [{
        id: 'r2', name: 'Former dev', profileId: 'deleted', enabled: true, priority: 100,
        match: { scheme: 'https', hostname: 'example.com' },
      }],
    ))
    await replaceProfileRules(data)
    await expect(chrome.storage.local.get(['profiles', 'routingRules'])).resolves.toEqual({
      profiles: [{ id: 'p2', name: 'Production' }],
      routingRules: [{
        id: 'r2', name: 'Former dev', profileId: 'deleted', enabled: true, priority: 100,
        match: { scheme: 'https', hostname: 'example.com' },
      }],
    })
  })

  it('rejects invalid input before any storage write', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'keep', name: 'Keep' }],
      routingRules: [],
    })
    await expect(Promise.resolve().then(() => parseProfileRulesTransfer(JSON.stringify({
      version: 1,
      profiles: [{ id: 'duplicate', name: 'A' }, { id: 'duplicate', name: 'B' }],
      rules: [],
    })))).rejects.toThrow('duplicated')
    await expect(chrome.storage.local.get(['profiles', 'routingRules'])).resolves.toEqual({
      profiles: [{ id: 'keep', name: 'Keep' }],
      routingRules: [],
    })
  })
})
