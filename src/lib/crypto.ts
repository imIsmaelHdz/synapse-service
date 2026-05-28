/**
 * Application-level encryption for sensitive note fields stored in PostgreSQL.
 *
 * Algorithm : AES-256-GCM (authenticated encryption — detects tampering)
 * Key source : DB_ENCRYPTION_KEY env var — 64 hex chars (32 bytes)
 *
 * Wire format (base64-encoded):
 *   [ 12 bytes IV ][ 16 bytes GCM auth tag ][ N bytes ciphertext ]
 *
 * The IV is random per call, so two encryptions of the same plaintext
 * produce different ciphertexts. The auth tag guarantees integrity.
 *
 * Key loss = permanent data loss. Back up DB_ENCRYPTION_KEY securely.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const ALGO        = 'aes-256-gcm'
const IV_BYTES    = 12   // 96-bit IV — recommended for GCM
const TAG_BYTES   = 16   // 128-bit auth tag

function key(): Buffer {
  const hex = process.env.DB_ENCRYPTION_KEY ?? ''
  if (hex.length !== 64) {
    throw new Error(
      'DB_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
      'Generate one with: openssl rand -hex 32',
    )
  }
  return Buffer.from(hex, 'hex')
}

/**
 * Encrypts a UTF-8 string. Returns a base64 string safe for storage.
 * Empty strings are returned as-is (no point encrypting empty fields).
 */
export function encrypt(plaintext: string): string {
  if (plaintext === '') return ''

  const iv     = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key(), iv)
  const body   = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag    = cipher.getAuthTag()

  return Buffer.concat([iv, tag, body]).toString('base64')
}

/**
 * Decrypts a value produced by encrypt(). Returns the original UTF-8 string.
 * Empty strings pass through unchanged.
 */
export function decrypt(ciphertext: string): string {
  if (ciphertext === '') return ''

  const buf      = Buffer.from(ciphertext, 'base64')
  const iv       = buf.subarray(0, IV_BYTES)
  const tag      = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const body     = buf.subarray(IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv(ALGO, key(), iv, { authTagLength: TAG_BYTES })
  decipher.setAuthTag(tag)

  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
}
