// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SAMPLE_SIZE, sampleDiverse } from '../../../src/routes/ai/sample'
import { makeNote, notesFromSources } from '../../helpers/fixtures'

describe('sampleDiverse', () => {
  it('returns all notes when count >= length', () => {
    const notes = [makeNote('a'), makeNote('b')]
    assert.equal(sampleDiverse(notes, 10).length, 2)
  })

  it('returns at most count notes', () => {
    const notes = notesFromSources(5, ['s1', 's2', 's3'])
    const result = sampleDiverse(notes, 10, () => 0)
    assert.equal(result.length, 10)
  })

  it('round-robins across sourceId buckets', () => {
    const notes = notesFromSources(4, ['book-a', 'book-b'])
    const result = sampleDiverse(notes, 4, () => 0)
    const sources = new Set(result.map((n) => n.sourceId))
    assert.equal(sources.size, 2)
    assert.ok(sources.has('book-a'))
    assert.ok(sources.has('book-b'))
  })

  it('groups notes without sourceId into one bucket', () => {
    const notes = Array.from({ length: 6 }, (_, i) =>
      makeNote(`n${i}`, { sourceId: undefined }),
    )
    const result = sampleDiverse(notes, 3, () => 0)
    assert.equal(result.length, 3)
  })

  it('stops when all buckets are exhausted before count', () => {
    const notes = [makeNote('a', { sourceId: 'x' }), makeNote('b', { sourceId: 'y' })]
    const result = sampleDiverse(notes, 10, () => 0)
    assert.equal(result.length, 2)
  })
})

describe('SAMPLE_SIZE default', () => {
  it('uses SAMPLE_SIZE when count omitted', () => {
    const notes = notesFromSources(3, Array.from({ length: 15 }, (_, i) => `s${i}`))
    const result = sampleDiverse(notes, SAMPLE_SIZE, () => 0.5)
    assert.equal(result.length, SAMPLE_SIZE)
  })
})
