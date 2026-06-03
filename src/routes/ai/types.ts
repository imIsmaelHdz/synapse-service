// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

export interface Note {
  id:       string
  title:    string
  content:  string
  sourceId?: string  // book/movie/serie/topic id — used for diverse graph sampling
}

export interface Suggestion {
  source_note_id: string
  target_note_id: string
  reason:         string
}

export interface ExistingLink {
  source_note_id: string
  target_note_id: string
}

export interface DiscoverItem {
  title:   string
  creator: string
  reason:  string
}

export interface DiscoverResult {
  book:  DiscoverItem
  movie: DiscoverItem
  serie: DiscoverItem
}

export interface ExistingItem {
  title:   string
  creator: string
  type:    string
}

export type ReturnType = 'book' | 'movie' | 'serie'
