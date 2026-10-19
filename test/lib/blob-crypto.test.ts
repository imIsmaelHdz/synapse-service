// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'crypto'
import { openBlob, sealBlob, sha256Hex } from '../../src/lib/blob-crypto'
import { VALID_ENCRYPTION_KEY } from '../helpers/fixtures'

describe('blob-crypto', () => {
  before(() => { process.env.DB_ENCRYPTION_KEY = VALID_ENCRYPTION_KEY })

  it('round-trips bytes', () => {
    const plain = randomBytes(100_000)
    const { sealed, wrappedKey } = sealBlob(plain)
    assert.deepEqual(openBlob(sealed, wrappedKey), plain)
  })

  it('never stores plaintext and uses a fresh key per file', () => {
    const plain = Buffer.from('receipt '.repeat(100))
    const a = sealBlob(plain)
    const b = sealBlob(plain)
    assert.equal(a.sealed.includes(Buffer.from('receipt')), false)
    assert.notEqual(a.wrappedKey, b.wrappedKey)
    assert.notDeepEqual(a.sealed, b.sealed)
  })

  it('rejects tampered ciphertext', () => {
    const { sealed, wrappedKey } = sealBlob(Buffer.from('hello'))
    sealed[sealed.length - 1] ^= 0xff
    assert.throws(() => openBlob(sealed, wrappedKey))
  })

  it('rejects a key wrapped for another file', () => {
    const a = sealBlob(Buffer.from('one'))
    const b = sealBlob(Buffer.from('two'))
    assert.throws(() => openBlob(a.sealed, b.wrappedKey))
  })

  it('hashes with sha256 hex', () => {
    assert.equal(
      sha256Hex(Buffer.from('abc')),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})
