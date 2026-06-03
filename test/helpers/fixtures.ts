// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

import type { Note } from '../../src/routes/ai/types'

export const VALID_ENCRYPTION_KEY = 'a'.repeat(64)

export function makeNote (
  id: string,
  overrides: Partial<Note> = {},
): Note {
  return {
    id,
    title:    `Title ${id}`,
    content:  `Content for ${id}`,
    sourceId: 'book-1',
    ...overrides,
  }
}

export function notesFromSources (
  perSource: number,
  sourceIds: string[],
): Note[] {
  const notes: Note[] = []
  for (const sourceId of sourceIds) {
    for (let i = 0; i < perSource; i++) {
      notes.push(makeNote(`${sourceId}-n${i}`, { sourceId }))
    }
  }
  return notes
}
