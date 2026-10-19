// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { checkProtectedFields, isE2e, openAtRest, sealAtRest } from '../../src/lib/e2e'
import { VALID_ENCRYPTION_KEY } from '../helpers/fixtures'
import type { PushBody } from '../../src/routes/sync/types'

const sealed = 'e2e:v1:' + Buffer.from('x'.repeat(40)).toString('base64')

function body (overrides: Partial<{ title: string, body: string, reason: string, bookTitle: string }> = {}): PushBody {
  return {
    books: [{ id: 'b1', title: overrides.bookTitle ?? 'Book', author: '', colorIndex: 0, type: 'book', createdAt: 1 }],
    notes: [{ id: 'n1', title: overrides.title ?? 'T', body: overrides.body ?? 'B', bookId: 'b1', topic: '', createdAt: 1, updatedAt: 1 }],
    links: [{ id: 'l1', sourceId: 'n1', targetId: 'n1', isManual: true, reason: overrides.reason, createdAt: 1 }],
    exported_at: 'now',
  }
}

describe('e2e field rules', () => {
  before(() => { process.env.DB_ENCRYPTION_KEY = VALID_ENCRYPTION_KEY })

  it('recognises sealed values', () => {
    assert.equal(isE2e(sealed), true)
    assert.equal(isE2e('plain'), false)
    assert.equal(isE2e(null), false)
  })

  it('at-rest sealing passes e2e values through and round-trips plaintext', () => {
    assert.equal(sealAtRest(sealed), sealed)
    assert.equal(openAtRest(sealed), sealed)
    const atRest = sealAtRest('hello')
    assert.notEqual(atRest, 'hello')
    assert.equal(openAtRest(atRest), 'hello')
  })

  it('accepts plaintext for regular accounts within the old limits', () => {
    assert.equal(checkProtectedFields(body(), false), null)
    assert.match(checkProtectedFields(body({ body: 'x'.repeat(50001) }), false)!, /exceeds 50000/)
    assert.match(checkProtectedFields(body({ bookTitle: 'x'.repeat(501) }), false)!, /exceeds 500/)
  })

  it('lets sealed values be longer than the plaintext caps', () => {
    const long = 'e2e:v1:' + Buffer.alloc(51000, 7).toString('base64')
    assert.equal(checkProtectedFields(body({ body: long, title: sealed, bookTitle: sealed }), true), null)
  })

  it('rejects plaintext for e2e accounts, but allows empty and absent fields', () => {
    assert.match(checkProtectedFields(body({ title: sealed, body: 'leak', bookTitle: sealed }), true)!, /note\.body of n1 must be end-to-end encrypted/)
    assert.match(checkProtectedFields(body({ title: sealed, body: sealed, bookTitle: 'Plain' }), true)!, /book\.title/)
    assert.match(checkProtectedFields(body({ title: sealed, body: sealed, bookTitle: sealed, reason: 'why' }), true)!, /link\.reason/)
    assert.equal(checkProtectedFields(body({ title: sealed, body: sealed, bookTitle: sealed }), true), null)
  })

  it('rejects malformed sealed values', () => {
    assert.match(checkProtectedFields(body({ body: 'e2e:v1:%%%' }), false)!, /not a valid e2e:v1 value/)
  })
})
