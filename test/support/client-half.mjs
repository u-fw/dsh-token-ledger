/**
 * Load the browser bundle in Node.
 *
 * The client half is a browser artifact: it registers itself on
 * `window.__ModuleLoader__` and requires the platform seed words. Stubbing both
 * lets its pure exports be exercised without a browser or a DOM.
 *
 * Each test file runs in its own process, so the module-level registration
 * happens once per file.
 *
 * @module dsh-token-ledger/test/support/client-half
 */

import assert from 'node:assert/strict'

/**
 * Register the bundle against a stubbed loader and return its exports.
 *
 * @returns the client half's exports (`apply`, `inject`, `deriveView`, …).
 */
export async function loadClientHalf() {
  const registrations = []
  const previous = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } }
  try {
    await import('../../lib/client.js')
  } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }
  assert.equal(registrations.length, 1, 'the bundle must register exactly once')
  const registration = registrations[0]
  assert.equal(registration.id, 'dsh-token-ledger', 'the registration id must be the package name')
  return registration.factory((specifier) => {
    if (specifier === 'react') {
      // Enough of React for module evaluation; nothing here renders.
      return {
        createElement: () => null,
        useState: () => [],
        useEffect: () => {},
        useMemo: (compute) => compute(),
        useCallback: (fn) => fn,
      }
    }
    throw new Error(`unexpected require("${specifier}") — not a platform seed word`)
  })
}
