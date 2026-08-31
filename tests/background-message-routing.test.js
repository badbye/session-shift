import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let consoleError

beforeEach(() => {
  vi.resetModules()
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleError.mockRestore()
})

async function loadMessageListener() {
  await import('../src/background/index.ts')
  const listeners = chrome.runtime.onMessage.addListener.mock.calls
  return listeners[listeners.length - 1][0]
}

describe('background message routing', () => {
  it('silently drops a response when the sender frame navigated away', async () => {
    const listener = await loadMessageListener()
    const sendResponse = vi.fn(() => {
      // Chrome API errors can originate from a different realm and do not
      // necessarily satisfy `error instanceof Error` in the service worker.
      throw { message: 'Frame with ID 0 was removed.' }
    })

    expect(listener({ action: 'getRules' }, { id: chrome.runtime.id }, sendResponse)).toBe(true)

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ rules: [] }))
    expect(consoleError).not.toHaveBeenCalled()
  })
})
