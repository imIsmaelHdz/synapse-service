// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

import { FastifyPluginAsync } from 'fastify'

const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            status:      { type: 'string' },
            version:     { type: 'string' },
            environment: { type: 'string' },
            timestamp:   { type: 'string' },
            uptime:      { type: 'number' },
            db:          {
              type: 'object',
              properties: {
                status:      { type: 'string' },
                responseMs:  { type: 'number' },
              },
            },
            services: {
              type: 'object',
              properties: {
                gemini:   { type: 'string' },
                firebase: { type: 'string' },
              },
            },
            memory: {
              type: 'object',
              properties: {
                usedMb:  { type: 'number' },
                totalMb: { type: 'number' },
              },
            },
          },
        },
        503: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            error:  { type: 'string' },
          },
        },
      },
    },
  }, async (_request, reply) => {

    // Database check
    let dbResponseMs = 0
    try {
      const t0 = Date.now()
      await fastify.pg.query('SELECT 1')
      dbResponseMs = Date.now() - t0
    } catch (err) {
      fastify.log.error(err, 'Health check: database unreachable')
      return reply.status(503).send({
        status: 'degraded',
        error:  'Database connection failed',
      })
    }

    // Memory
    const mem     = process.memoryUsage()
    const usedMb  = Math.round(mem.rss       / 1024 / 1024)
    const totalMb = Math.round(mem.heapTotal / 1024 / 1024)

    return {
      status:      'ok',
      version:     process.env.npm_package_version ?? '1.0.0',
      environment: process.env.NODE_ENV ?? 'development',
      timestamp:   new Date().toISOString(),
      uptime:      Math.floor(process.uptime()),
      db: {
        status:     'ok',
        responseMs: dbResponseMs,
      },
      services: {
        gemini:   process.env.GEMINI_API_KEY   ? 'configured' : 'missing',
        firebase: process.env.FIREBASE_PROJECT_ID ? 'configured' : 'missing',
      },
      memory: {
        usedMb,
        totalMb,
      },
    }
  })
}

export default healthRoutes
