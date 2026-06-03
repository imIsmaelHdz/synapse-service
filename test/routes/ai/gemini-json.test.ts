// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeSuggestions,
  parseDiscoverBatchResult,
  parseGeminiJsonObject,
  sanitiseDiscoverItem,
} from '../../../src/routes/ai/gemini-json'

describe('parseGeminiJsonObject', () => {
  it('parses JSON wrapped in markdown', () => {
    const raw = 'Here is the result:\n```json\n{"suggestions":[]}\n```\nThanks'
    const parsed = parseGeminiJsonObject(raw)
    assert.deepEqual(parsed.suggestions, [])
  })

  it('uses first { through last }', () => {
    const raw = 'prefix {"a":1,"nested":{"b":2}} suffix'
    assert.deepEqual(parseGeminiJsonObject(raw), { a: 1, nested: { b: 2 } })
  })

  it('throws when no JSON object present', () => {
    assert.throws(() => parseGeminiJsonObject('no json here'), /No JSON object/)
  })
})

describe('normalizeSuggestions', () => {
  const noteIds = new Set(['a', 'b', 'c'])

  it('keeps valid suggestions and caps at 3', () => {
    const parsed = {
      suggestions: [
        { source_note_id: 'a', target_note_id: 'b', reason: 'r1' },
        { source_note_id: 'b', target_note_id: 'c', reason: 'r2' },
        { source_note_id: 'a', target_note_id: 'c', reason: 'r3' },
        { source_note_id: 'c', target_note_id: 'a', reason: 'r4' },
      ],
    }
    assert.equal(normalizeSuggestions(parsed, noteIds).length, 3)
  })

  it('drops unknown note ids and self-loops', () => {
    const parsed = {
      suggestions: [
        { source_note_id: 'a', target_note_id: 'z', reason: 'bad id' },
        { source_note_id: 'a', target_note_id: 'a', reason: 'loop' },
        { source_note_id: 'a', target_note_id: 'b', reason: 42 },
        { source_note_id: 'a', target_note_id: 'b', reason: 'ok' },
      ],
    }
    const out = normalizeSuggestions(parsed, noteIds)
    assert.equal(out.length, 1)
    assert.equal(out[0].reason, 'ok')
  })
})

describe('sanitiseDiscoverItem', () => {
  it('coerces fields to strings with defaults', () => {
    assert.deepEqual(
      sanitiseDiscoverItem({ title: 1, creator: null, reason: undefined }),
      { title: '1', creator: '', reason: '' },
    )
  })
})

describe('parseDiscoverBatchResult', () => {
  it('sanitises book, movie, and serie branches', () => {
    const result = parseDiscoverBatchResult({
      book:  { title: 'B' },
      movie: { creator: 'M' },
      serie: { reason: 'S' },
    })
    assert.equal(result.book.title, 'B')
    assert.equal(result.movie.creator, 'M')
    assert.equal(result.serie.reason, 'S')
  })
})
