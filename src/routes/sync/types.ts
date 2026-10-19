// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

// Payload types (mirror Flutter's toMap() output)
export interface BookPayload {
  id: string
  title: string
  author: string
  colorIndex: number
  createdAt: number   // milliseconds since epoch
  updatedAt?: number  // ms since epoch — drives last-write-wins; older clients omit it
  type: string
}

export interface NotePayload {
  id: string
  title: string
  body: string
  bookId: string
  topic: string
  createdAt: number
  updatedAt: number
}

export interface LinkPayload {
  id: string
  sourceId: string
  targetId: string
  isManual: boolean
  reason?: string   // manual link explanation — optional, plain text
  createdAt: number
  updatedAt?: number  // ms since epoch — drives last-write-wins; older clients omit it
}

export interface PushBody {
  books: BookPayload[]
  notes: NotePayload[]
  links: LinkPayload[]
  exported_at: string
  // Explicit tombstones — ids the device deleted since its last sync.
  // When present, the server deletes exactly these (delta mode) instead of
  // inferring deletes from absence. Older clients omit them.
  deletedBookIds?: string[]
  deletedNoteIds?: string[]
  deletedLinkIds?: string[]
}

export interface LayoutPoint {
  note_id: string
  x: number
  y: number
}

// Database row types (SELECT result shapes)
// These are passed as the generic parameter to fastify.pg.query<T>() so the
// compiler verifies that every property access on `rows` is valid.

export interface BookRow {
  id:          string
  title:       string
  author:      string
  color_index: number
  type:        string
  created_at:  string  // bigint epoch ms returned as string by pg driver
  updated_at:  string
}

export interface NoteRow {
  id:         string
  title:      string  // AES-256-GCM encrypted
  body:       string  // AES-256-GCM encrypted
  book_id:    string | null
  topic:      string  // AES-256-GCM encrypted
  created_at: string
  updated_at: string
}

export interface LinkRow {
  id:         string
  source_id:  string
  target_id:  string
  is_manual:  boolean
  reason:     string | null
  created_at: string
  updated_at: string
}

export interface SnapshotRow {
  id:         string
  payload:    unknown  // opaque JSONB blob — shaped by Flutter
  created_at: string
}

export interface LayoutRow {
  note_id: string
  x:       number
  y:       number
}
