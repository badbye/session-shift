import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The Storage inspector reads the browser Cookie jar for the Default Profile,
// so cookies is intentionally a required permission alongside alarms.
describe('manifest permissions', () => {
  const manifest = JSON.parse(
    readFileSync(resolve(process.cwd(), 'src/manifest.json'), 'utf8'),
  )

  it('includes alarms and cookies for the Storage inspector', () => {
    expect(manifest.permissions).toContain('alarms')
    expect(manifest.permissions).toContain('cookies')
  })

  // Phase 4 (tab-group sync): tabGroups MUST stay optional. Adding it to
  // `permissions` would trigger Chrome's re-acceptance prompt on update for
  // every existing install to ship an opt-in, default-off feature.
  it('declares tabGroups as optional, never required', () => {
    expect(manifest.optional_permissions).toContain('tabGroups')
    expect(manifest.permissions).not.toContain('tabGroups')
  })

  it('declares default_locale and localizes only Chrome-owned name/description/command fields', () => {
    expect(manifest.default_locale).toBe('en')
    expect(manifest.name).toBe('__MSG_extensionName__')
    expect(manifest.description).toBe('__MSG_extensionDescription__')
    expect(manifest.commands._execute_action.description).toBe('__MSG_commandExecuteActionDescription__')
    expect(manifest.commands['session-next'].description).toBe('__MSG_commandSessionNextDescription__')
    expect(manifest.commands['session-prev'].description).toBe('__MSG_commandSessionPrevDescription__')
  })

  it('every __MSG_ token in the manifest resolves in the English catalog', () => {
    const english = JSON.parse(
      readFileSync(resolve(process.cwd(), 'src/_locales/en/messages.json'), 'utf8'),
    )
    const raw = readFileSync(resolve(process.cwd(), 'src/manifest.json'), 'utf8')
    const tokens = [...raw.matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)].map((m) => m[1])
    expect(tokens.length).toBeGreaterThan(0)
    for (const key of tokens) {
      expect(english[key]?.message?.length).toBeGreaterThan(0)
    }
  })
})
