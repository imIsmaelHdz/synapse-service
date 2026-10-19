// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

/**
 * End-to-end encrypted fields (spec: Synapse docs/specs/end-to-end-encryption.md).
 *
 * The app seals note title/body/topic, book title/author/coverUrl and link
 * reason on the device as `e2e:v1:<base64(nonce|ciphertext|tag)>`. The server
 * can't open these: it stores and returns them byte for byte. Values without
 * the prefix are legacy plaintext from accounts that haven't turned E2E on;
 * those keep the old server-side sealing (crypto.ts).
 *
 * Once `users.e2e_enabled` is set, a push that carries plaintext in any of
 * these fields is rejected, so an old app version or a device without the
 * account key can't quietly write readable text again.
 */

import { decrypt, encrypt } from './crypto'
import type { PushBody } from '../routes/sync/types'

export const E2E_PREFIX = 'e2e:v1:'
const E2E_RE = /^e2e:v1:[A-Za-z0-9+/]+={0,2}$/

export function isE2e (value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(E2E_PREFIX)
}

/** Server-side at-rest sealing for legacy plaintext; e2e values pass through. */
export function sealAtRest (value: string): string {
  return isE2e(value) ? value : encrypt(value)
}

/** A well-formed e2e:v1 value (e.g. an app-wrapped file key). */
export function isValidE2e (value: unknown): value is string {
  return typeof value === 'string' && E2E_RE.test(value)
}

/** Opposite of sealAtRest: e2e values pass through untouched. */
export function openAtRest (value: string): string {
  return isE2e(value) ? value : decrypt(value)
}

// Plaintext caps (the old limits). Sealed values may be longer — base64 and
// the nonce/tag add ~35% — so the JSON schema allows the sealed size and
// these caps apply only to plaintext.
const PLAINTEXT_MAX = {
  'book.title':    500,
  'book.author':   500,
  'book.coverUrl': 2000,
  'note.title':    500,
  'note.body':     50000,
  'note.topic':    200,
  'link.reason':   2000,
  'attachment.fileName': 500,
} as const

type Field = keyof typeof PLAINTEXT_MAX

function protectedFields (body: PushBody): Array<[Field, string, unknown]> {
  const out: Array<[Field, string, unknown]> = []
  for (const b of body.books) {
    out.push(['book.title', b.id, b.title], ['book.author', b.id, b.author], ['book.coverUrl', b.id, b.coverUrl])
  }
  for (const n of body.notes) {
    out.push(['note.title', n.id, n.title], ['note.body', n.id, n.body], ['note.topic', n.id, n.topic])
  }
  for (const l of body.links) out.push(['link.reason', l.id, l.reason])
  for (const a of body.attachments ?? []) out.push(['attachment.fileName', a.id, a.fileName])
  return out
}

/**
 * Validates the protected fields of a push. Returns an error message for a
 * 400, or null when the push is acceptable:
 * - sealed values must be well-formed e2e:v1 strings;
 * - plaintext must fit the old limits;
 * - an e2e account may not send non-empty plaintext.
 */
export function checkProtectedFields (body: PushBody, e2eEnabled: boolean): string | null {
  for (const [field, id, value] of protectedFields(body)) {
    if (value === undefined || value === null || value === '') continue
    if (typeof value !== 'string') return `${field} of ${id} must be a string`
    if (isE2e(value)) {
      if (!E2E_RE.test(value)) return `${field} of ${id} is not a valid e2e:v1 value`
      continue
    }
    if (e2eEnabled) return `${field} of ${id} must be end-to-end encrypted for this account`
    if (value.length > PLAINTEXT_MAX[field]) {
      return `${field} of ${id} exceeds ${PLAINTEXT_MAX[field]} characters`
    }
  }
  return null
}
