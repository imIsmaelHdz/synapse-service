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
          },
        },
      },
    },
  }, async () => ({
    status:  'ok',
    version: process.env.npm_package_version ?? '1.0.0',
    build:   'discover-fix-v3',
  }))
}

export default healthRoutes
