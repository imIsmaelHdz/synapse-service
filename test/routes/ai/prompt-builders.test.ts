import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDiscoverPrompt,
  buildDiscoverSinglePrompt,
  buildPrompt,
} from '../../../src/routes/ai/prompt-builders'
import { MAX_CONTENT } from '../../../src/routes/ai/sample'
import { makeNote } from '../../helpers/fixtures'

describe('buildPrompt', () => {
  it('includes note ids and truncates content', () => {
    const long = 'x'.repeat(MAX_CONTENT + 50)
    const prompt = buildPrompt(
      [makeNote('n1', { content: long }), makeNote('n2')],
      [],
    )
    assert.ok(prompt.includes('[n1]'))
    assert.ok(!prompt.includes('x'.repeat(MAX_CONTENT + 10)))
  })

  it('appends existing link exclusions', () => {
    const prompt = buildPrompt(
      [makeNote('a'), makeNote('b')],
      [{ source_note_id: 'a', target_note_id: 'b' }],
    )
    assert.ok(prompt.includes('Do NOT suggest'))
    assert.ok(prompt.includes('a ↔ b'))
  })
})

describe('buildDiscoverSinglePrompt', () => {
  it('formats source with creator', () => {
    const prompt = buildDiscoverSinglePrompt('Dune', 'Herbert', 'book', 'movie')
    assert.ok(prompt.includes('"Dune" by Herbert (book)'))
    assert.ok(prompt.includes('movie (real, released'))
  })

  it('formats source without creator', () => {
    const prompt = buildDiscoverSinglePrompt('Topic', '', 'topic', 'book')
    assert.ok(prompt.includes('"Topic" (topic)'))
    assert.ok(prompt.includes('Author name'))
  })

  it('includes library exclusions', () => {
    const prompt = buildDiscoverSinglePrompt('X', '', 'book', 'serie', [
      { title: 'Taken', creator: 'Host', type: 'serie' },
    ])
    assert.ok(prompt.includes('Taken'))
    assert.ok(prompt.includes('already in the user'))
  })
})

describe('buildDiscoverPrompt', () => {
  it('batch prompt includes source and exclusions', () => {
    const prompt = buildDiscoverPrompt('Art', 'Author', 'book', [
      { title: 'Old', creator: '', type: 'book' },
    ])
    assert.ok(prompt.includes('"Art" by Author (book)'))
    assert.ok(prompt.includes('Old'))
    assert.ok(prompt.includes('do NOT recommend'))
  })
})
