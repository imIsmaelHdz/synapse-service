import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  CACHE_MAX,
  CACHE_TTL_MS,
  cacheDelete,
  cacheGet,
  cacheKey,
  cacheSet,
  resetDiscoverCache,
} from '../../../src/routes/ai/discover-cache'

const item = { title: 'Dune', creator: 'Herbert', reason: 'Because sci-fi' }

describe('discover-cache', () => {
  let dateNow: typeof Date.now

  beforeEach(() => {
    resetDiscoverCache()
    dateNow = Date.now
  })

  afterEach(() => {
    Date.now = dateNow
    resetDiscoverCache()
  })

  it('normalizes cacheKey parts', () => {
    assert.equal(
      cacheKey(' Title ', ' Creator ', ' Book ', ' movie '),
      'title::creator::book::movie',
    )
  })

  it('stores and retrieves items', () => {
    const key = cacheKey('a', 'b', 'book', 'movie')
    cacheSet(key, item)
    assert.deepEqual(cacheGet(key), item)
  })

  it('cacheDelete removes entries', () => {
    const key = cacheKey('x', '', 'book', 'book')
    cacheSet(key, item)
    cacheDelete(key)
    assert.equal(cacheGet(key), null)
  })

  it('returns null after TTL expires', () => {
    const key = cacheKey('ttl', '', 'book', 'book')
    const t0 = 1_700_000_000_000
    Date.now = () => t0
    cacheSet(key, item)
    Date.now = () => t0 + CACHE_TTL_MS + 1
    assert.equal(cacheGet(key), null)
  })

  it('evicts oldest entry when at capacity', () => {
    const t0 = 1_700_000_000_000
    Date.now = () => t0

    for (let i = 0; i < CACHE_MAX; i++) {
      cacheSet(`key-${i}`, { ...item, title: `t${i}` })
    }

    const firstKey = 'key-0'
    assert.ok(cacheGet(firstKey))

    cacheSet('key-overflow', { ...item, title: 'overflow' })
    assert.equal(cacheGet(firstKey), null)
    assert.ok(cacheGet('key-overflow'))
  })
})
