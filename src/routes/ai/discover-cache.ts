import type { DiscoverItem } from './types'

//Server-side discover cache
// Keyed by "title::creator::sourceType::returnType" (all lowercased + trimmed).
// Ignores the per-user `existing` exclusion list for caching — the chance of
// Gemini recommending something the user already has is very low for popular
// titles, and the speed benefit is significant.
//
// TTL  : 24 hours — recommendations are stable over that window
// Max  : 500 entries — each entry is ~200 bytes; total ≤ 100 KB RAM

interface DiscoverCacheEntry {
  item:      DiscoverItem
  expiresAt: number
}

const _discoverCache = new Map<string, DiscoverCacheEntry>()
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000
export const CACHE_MAX    = 500

export function resetDiscoverCache (): void {
  _discoverCache.clear()
}

export function cacheKey(title: string, creator: string, sourceType: string, returnType: string): string {
  return [title, creator, sourceType, returnType].map((s) => s.trim().toLowerCase()).join('::')
}

export function cacheGet(key: string): DiscoverItem | null {
  const entry = _discoverCache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) { _discoverCache.delete(key); return null }
  return entry.item
}

export function cacheSet(key: string, item: DiscoverItem): void {
  if (_discoverCache.size >= CACHE_MAX) {
    // Evict the oldest insertion (Map preserves insertion order)
    const firstKey = _discoverCache.keys().next().value
    if (firstKey !== undefined) _discoverCache.delete(firstKey)
  }
  _discoverCache.set(key, { item, expiresAt: Date.now() + CACHE_TTL_MS })
}

export function cacheDelete(key: string): void {
  _discoverCache.delete(key)
}
