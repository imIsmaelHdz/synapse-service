// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  getSuggestUsageToday,
  incrementSuggestUsage,
} from '../../../src/routes/ai/usage'
import { MockPgClient } from '../../helpers/mock-pg'

const TODAY = '2026-06-03'
const UID   = 'user-123'

describe('getSuggestUsageToday', () => {
  it('upserts user and ai_usage then returns count', async () => {
    const client = new MockPgClient({ suggestCount: 2 })
    const count  = await getSuggestUsageToday(client, UID, TODAY)

    assert.equal(count, 2)
    assert.ok(client.calls.some((c) => c.sql.includes('INSERT INTO users')))
    assert.ok(client.calls.some((c) => c.sql.includes('INSERT INTO ai_usage')))
    assert.ok(client.calls.some((c) => c.sql.includes('ON CONFLICT') && c.sql.includes('ai_usage')))
    assert.deepEqual(
      client.calls.find((c) => c.sql.includes('SELECT suggest_count'))!.params,
      [UID, TODAY],
    )
  })

  it('returns 0 when count row is missing', async () => {
    const client = new MockPgClient({ suggestCount: null })
    const count  = await getSuggestUsageToday(client, UID, TODAY)
    assert.equal(count, 0)
  })

  it('returns 0 when database throws', async () => {
    const client = new MockPgClient({ throwOn: 'any' })
    assert.equal(await getSuggestUsageToday(client, UID, TODAY), 0)
  })
})

describe('incrementSuggestUsage', () => {
  it('updates counter for uid and date', async () => {
    const client = new MockPgClient()
    await incrementSuggestUsage(client, UID, TODAY)

    const update = client.calls.find((c) => c.sql.includes('UPDATE ai_usage'))
    assert.ok(update)
    assert.deepEqual(update!.params, [UID, TODAY])
  })

  it('swallows database errors', async () => {
    const client = new MockPgClient({ throwOn: 'any' })
    await assert.doesNotReject(() => incrementSuggestUsage(client, UID, TODAY))
  })
})
