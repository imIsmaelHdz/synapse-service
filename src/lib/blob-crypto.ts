// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

/**
 * Envelope encryption for attachment bytes stored in the bucket.
 *
 * Each file gets a random 32-byte data key. The bytes are sealed with
 * AES-256-GCM under that key, and the data key is wrapped with
 * DB_ENCRYPTION_KEY via encrypt() and stored in the attachments row. The
 * bucket therefore only ever holds ciphertext, and a leaked bucket credential
 * is useless without the database and the master key.
 *
 * Blob wire format: [ 12 bytes IV ][ 16 bytes GCM auth tag ][ ciphertext ]
 *
 * Files are capped at 25 MB, so sealing in memory is fine and keeps the
 * format identical to the text helpers.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import { decrypt, encrypt } from './crypto'

const ALGO      = 'aes-256-gcm'
const IV_BYTES  = 12
const TAG_BYTES = 16

export function sealBlob (plain: Buffer): { sealed: Buffer, wrappedKey: string } {
  const dataKey = randomBytes(32)
  const iv      = randomBytes(IV_BYTES)
  const cipher  = createCipheriv(ALGO, dataKey, iv)
  const body    = Buffer.concat([cipher.update(plain), cipher.final()])
  const sealed  = Buffer.concat([iv, cipher.getAuthTag(), body])
  return { sealed, wrappedKey: encrypt(dataKey.toString('hex')) }
}

export function openBlob (sealed: Buffer, wrappedKey: string): Buffer {
  const dataKey  = Buffer.from(decrypt(wrappedKey), 'hex')
  const iv       = sealed.subarray(0, IV_BYTES)
  const tag      = sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const body     = sealed.subarray(IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv(ALGO, dataKey, iv, { authTagLength: TAG_BYTES })
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}

export function sha256Hex (buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}
