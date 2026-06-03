// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

import type { Note } from './types'

export const SAMPLE_SIZE = 10    // notes sent to Gemini per request
export const MAX_CONTENT = 400   // chars per note

/**
 * Picks `count` notes spread across different books/sources (graph sections).
 * Round-robins across books so no single source dominates the batch.
 * Falls back to a simple random shuffle when bookId is absent.
 */
export function sampleDiverse (
  notes: Note[],
  count = SAMPLE_SIZE,
  rng: () => number = Math.random,
): Note[] {
  if (notes.length <= count) return notes

  // Group by bookId (or a single "unknown" bucket if missing)
  const byBook = new Map<string, Note[]>()
  for (const note of notes) {
    const key = note.sourceId ?? '__unknown__'
    if (!byBook.has(key)) byBook.set(key, [])
    byBook.get(key)!.push(note)
  }

  // Shuffle each bucket so round-robin picks are random within each book
  for (const bucket of byBook.values()) {
    for (let i = bucket.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      ;[bucket[i], bucket[j]] = [bucket[j], bucket[i]]
    }
  }

  const buckets  = [...byBook.values()]
  const pointers = new Array(buckets.length).fill(0)
  const result: Note[] = []

  // Round-robin until we have `count` notes or exhaust all buckets
  let round = 0
  while (result.length < count) {
    let added = false
    for (let b = 0; b < buckets.length && result.length < count; b++) {
      const ptr = pointers[b]
      if (ptr < buckets[b].length) {
        result.push(buckets[b][ptr])
        pointers[b]++
        added = true
      }
    }
    if (!added) break  // all buckets exhausted
    round++
  }

  return result
}
