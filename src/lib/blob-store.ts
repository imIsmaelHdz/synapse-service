// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

/**
 * Where attachment bytes live. Production uses a private S3-compatible bucket
 * (Railway Bucket); tests use the in-memory store. Keys are always
 * `u/<uid>/att/<attachmentId>` (see attachmentKey) so every object is scoped
 * to its owner.
 */
export interface BlobStore {
  put (key: string, body: Buffer): Promise<void>
  get (key: string): Promise<Buffer | null>
  delete (keys: string[]): Promise<void>
}

export const attachmentKey = (uid: string, id: string) => `u/${uid}/att/${id}`

export class S3BlobStore implements BlobStore {
  constructor (private readonly s3: S3Client, private readonly bucket: string) {}

  async put (key: string, body: Buffer) {
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: body,
      ContentType: 'application/octet-stream',
    }))
  }

  async get (key: string) {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
      if (!res.Body) return null
      return Buffer.from(await res.Body.transformToByteArray())
    } catch (err) {
      if (err instanceof NoSuchKey) return null
      throw err
    }
  }

  async delete (keys: string[]) {
    // DeleteObjects takes at most 1000 keys per call.
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000)
      await this.s3.send(new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: { Objects: chunk.map(Key => ({ Key })), Quiet: true },
      }))
    }
  }
}

export class MemoryBlobStore implements BlobStore {
  readonly objects = new Map<string, Buffer>()
  async put (key: string, body: Buffer) { this.objects.set(key, Buffer.from(body)) }
  async get (key: string) { return this.objects.get(key) ?? null }
  async delete (keys: string[]) { for (const k of keys) this.objects.delete(k) }
}

/**
 * Builds the bucket client from env, or returns null when the bucket isn't
 * configured (attachment routes then answer 503 and push skips byte cleanup).
 */
export function blobStoreFromEnv (): BlobStore | null {
  const { BUCKET_ENDPOINT, BUCKET_NAME, BUCKET_ACCESS_KEY, BUCKET_SECRET_KEY } = process.env
  if (!BUCKET_ENDPOINT || !BUCKET_NAME || !BUCKET_ACCESS_KEY || !BUCKET_SECRET_KEY) return null
  const s3 = new S3Client({
    endpoint:       BUCKET_ENDPOINT,
    region:         process.env.BUCKET_REGION ?? 'auto',
    forcePathStyle: process.env.BUCKET_PATH_STYLE === 'true',
    credentials:    { accessKeyId: BUCKET_ACCESS_KEY, secretAccessKey: BUCKET_SECRET_KEY },
  })
  return new S3BlobStore(s3, BUCKET_NAME)
}
