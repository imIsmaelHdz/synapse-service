import { FastifyPluginAsync } from 'fastify'

const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            status:  { type: 'string' },
            version: { type: 'string' },
            db:      { type: 'string' },
            uptime:  { type: 'number' },
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
    // Verify the database is reachable — not just that the process is alive.
    // Load balancers use this endpoint; a 503 pulls the instance from rotation.
    try {
      await fastify.pg.query('SELECT 1')
    } catch (err) {
      fastify.log.error(err, 'Health check: database unreachable')
      return reply.status(503).send({
        status: 'degraded',
        error:  'Database connection failed',
      })
    }

    return {
      status:  'ok',
      version: process.env.npm_package_version ?? '1.0.0',
      db:      'ok',
      uptime:  Math.floor(process.uptime()),
    }
  })
}

export default healthRoutes
