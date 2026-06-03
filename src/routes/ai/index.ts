// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

import { FastifyPluginAsync } from 'fastify'
import { registerDiscoverRoute } from './handlers/discover'
import { registerSuggestRoute } from './handlers/suggest'

const aiRoutes: FastifyPluginAsync = async (fastify) => {
  registerSuggestRoute(fastify)
  registerDiscoverRoute(fastify)
}

export default aiRoutes
