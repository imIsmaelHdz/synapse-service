// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

import { FastifyPluginAsync } from 'fastify'
import { registerLayoutRoutes } from './handlers/layout'
import { registerPullRoute } from './handlers/pull'
import { registerPushRoute } from './handlers/push'

/**
 * Local-first sync — Hive is the source of truth on the device.
 *
 * POST /v1/sync/push   — Flutter uploads the full graph; backend upserts into
 *                        normalized tables (books / notes / note_links).
 * GET  /v1/sync/pull   — Flutter downloads the latest graph (new device / restore).
 *                        Reads from normalized tables; falls back to legacy
 *                        snapshots table if the user hasn't pushed yet.
 * POST /v1/sync/layout — Save force-directed node positions.
 * GET  /v1/sync/layout — Restore node positions.
 */
const syncRoutes: FastifyPluginAsync = async (fastify) => {
  registerPushRoute(fastify)
  registerPullRoute(fastify)
  registerLayoutRoutes(fastify)
}

export default syncRoutes
