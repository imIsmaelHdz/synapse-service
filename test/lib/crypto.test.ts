// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { encrypt, decrypt } from '../../src/lib/crypto'
import { VALID_ENCRYPTION_KEY } from '../helpers/fixtures'

describe('crypto', () => {
  const prev = process.env.DB_ENCRYPTION_KEY

  beforeEach(() => {
    process.env.DB_ENCRYPTION_KEY = VALID_ENCRYPTION_KEY
  })

  afterEach(() => {
    if (prev === undefined) delete process.env.DB_ENCRYPTION_KEY
    else process.env.DB_ENCRYPTION_KEY = prev
  })

  it('passes through empty strings', () => {
    assert.equal(encrypt(''), '')
    assert.equal(decrypt(''), '')
  })

  it('round-trips UTF-8 plaintext', () => {
    const plain = 'Note body with émoji 🔗\nand a second line'
    assert.equal(decrypt(encrypt(plain)), plain)
  })

  it('produces different ciphertext for the same plaintext', () => {
    const a = encrypt('same')
    const b = encrypt('same')
    assert.notEqual(a, b)
    assert.equal(decrypt(a), 'same')
    assert.equal(decrypt(b), 'same')
  })

  it('throws when DB_ENCRYPTION_KEY is invalid length', () => {
    process.env.DB_ENCRYPTION_KEY = 'tooshort'
    assert.throws(() => encrypt('x'), /64-character hex/)
  })

  it('throws on tampered ciphertext', () => {
    const buf = Buffer.from(encrypt('secret'), 'base64')
    buf[buf.length - 1] ^= 0xff
    assert.throws(() => decrypt(buf.toString('base64')))
  })

  it('throws on invalid base64 payload', () => {
    process.env.DB_ENCRYPTION_KEY = VALID_ENCRYPTION_KEY
    assert.throws(() => decrypt('not-valid-base64!!!'))
  })
})
