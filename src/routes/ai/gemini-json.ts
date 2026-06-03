// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

import type { DiscoverItem, DiscoverResult, Suggestion } from './types'

/** Extracts the outermost JSON object from a Gemini text response. */
export function parseGeminiJsonObject (raw: string): Record<string, unknown> {
  const start = raw.indexOf('{')
  const end   = raw.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('No JSON object found')
  return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
}

export function normalizeSuggestions (
  parsed: Record<string, unknown>,
  noteIds: Set<string>,
): Suggestion[] {
  return ((parsed.suggestions ?? []) as Suggestion[])
    .filter(
      (s) =>
        noteIds.has(s.source_note_id) &&
        noteIds.has(s.target_note_id) &&
        s.source_note_id !== s.target_note_id &&
        typeof s.reason === 'string',
    )
    .slice(0, 3)
}

export function sanitiseDiscoverItem (o: Record<string, unknown>): DiscoverItem {
  return {
    title:   String(o['title']   ?? ''),
    creator: String(o['creator'] ?? ''),
    reason:  String(o['reason']  ?? ''),
  }
}

export function parseDiscoverBatchResult (parsed: Record<string, unknown>): DiscoverResult {
  return {
    book:  sanitiseDiscoverItem((parsed['book']  as Record<string, unknown>) ?? {}),
    movie: sanitiseDiscoverItem((parsed['movie'] as Record<string, unknown>) ?? {}),
    serie: sanitiseDiscoverItem((parsed['serie'] as Record<string, unknown>) ?? {}),
  }
}
