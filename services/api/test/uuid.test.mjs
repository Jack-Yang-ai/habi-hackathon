import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUuid } from '../../../apps/studio/src/uuid.ts'

const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Runs `run` while `globalThis.crypto` is replaced, then restores the host's own descriptor. */
function withCrypto(replacement, run) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: replacement })
  try { return run() } finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original)
    else delete globalThis.crypto
  }
}

test('randomUuid uses the native implementation when the context offers it', () => {
  const id = withCrypto({ randomUUID: () => 'native-id', getRandomValues: () => { throw new Error('must not fall back') } }, () => randomUuid())
  assert.equal(id, 'native-id')
})

test('randomUuid builds a v4 id where crypto.randomUUID is absent (plain-HTTP page)', () => {
  // A page served over a LAN address is not a secure context: crypto exists, randomUUID does not.
  let requested = 0
  const id = withCrypto({ getRandomValues(bytes) { requested = bytes.length; bytes.fill(0x5a); return bytes } }, () => randomUuid())
  assert.equal(requested, 16, 'a full 128-bit value is drawn')
  assert.match(id, v4)
})

test('randomUuid still returns a v4 id when the page has no crypto object at all', () => {
  assert.match(withCrypto(undefined, () => randomUuid()), v4)
})

test('randomUuid keeps the version and variant bits', () => {
  const id = withCrypto({ getRandomValues(bytes) { bytes.fill(0xff); return bytes } }, () => randomUuid())
  assert.equal(id[14], '4', 'version nibble')
  assert.ok(['8', '9', 'a', 'b'].includes(id[19]), 'variant nibble')
})

test('randomUuid produces distinct ids for distinct random draws', () => {
  let counter = 0
  const ids = withCrypto({ getRandomValues(bytes) { counter += 1; bytes.fill(counter); return bytes } }, () => [randomUuid(), randomUuid(), randomUuid()])
  assert.equal(new Set(ids).size, 3)
  for (const id of ids) assert.match(id, v4)
})
