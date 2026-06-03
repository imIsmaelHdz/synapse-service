import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadPrompt } from '../../src/lib/prompt-loader'

describe('loadPrompt', () => {
  it('loads suggest prompt without YAML frontmatter', () => {
    const prompt = loadPrompt('suggest', { notes: 'NOTE_BLOCK' })
    assert.ok(prompt.includes('NOTE_BLOCK'))
    assert.ok(!prompt.startsWith('---'))
    assert.ok(prompt.includes('knowledge connection engine'))
  })

  it('substitutes all provided variables', () => {
    const prompt = loadPrompt('discover-single', {
      returnTypeLabel: 'LABEL',
      source:          'SOURCE',
      exclusions:      'EXCL',
      creatorLabel:    'CREATOR',
    })
    assert.ok(prompt.includes('LABEL'))
    assert.ok(prompt.includes('SOURCE'))
    assert.ok(prompt.includes('EXCL'))
    assert.ok(prompt.includes('CREATOR'))
  })

  it('replaces only provided placeholders', () => {
    const prompt = loadPrompt('suggest', { notes: 'x' })
    assert.ok(!prompt.includes('{{notes}}'))
  })

  it('caches file content across calls', () => {
    const a = loadPrompt('suggest', { notes: 'first' })
    const b = loadPrompt('suggest', { notes: 'second' })
    assert.notEqual(a, b)
    assert.ok(a.includes('first'))
    assert.ok(b.includes('second'))
  })
})
