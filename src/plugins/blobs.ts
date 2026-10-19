// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

import fp from 'fastify-plugin'
import { BlobStore, blobStoreFromEnv } from '../lib/blob-store'

declare module 'fastify' {
  interface FastifyInstance {
    /** Attachment byte store; null when the bucket env vars are missing. */
    blobs: BlobStore | null
  }
}

export default fp<{ store?: BlobStore | null }>(async (fastify, opts) => {
  const store = opts.store !== undefined ? opts.store : blobStoreFromEnv()
  if (!store) fastify.log.warn('Bucket not configured — attachment uploads disabled')
  fastify.decorate('blobs', store)
}, { name: 'blobs' })
