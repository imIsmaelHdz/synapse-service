import Fastify  from 'fastify'
import cors     from '@fastify/cors'
import helmet   from '@fastify/helmet'
import sensible from '@fastify/sensible'

import firebasePlugin from './plugins/firebase'
import postgresPlugin from './plugins/postgres'

import healthRoutes from './routes/health'
import userRoutes   from './routes/users'
import syncRoutes   from './routes/sync'
import aiRoutes     from './routes/ai'

export async function buildApp () {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      ...(process.env.NODE_ENV === 'development' && {
        transport: { target: 'pino-pretty' },
      }),
    },
  })

  await app.register(helmet)
  await app.register(cors, {
    origin: process.env.ALLOWED_ORIGINS?.split(',') ?? '*',
  })
  await app.register(sensible)

  await app.register(postgresPlugin)
  await app.register(firebasePlugin)

  await app.register(healthRoutes)
  await app.register(userRoutes, { prefix: '/v1/users' })
  await app.register(syncRoutes, { prefix: '/v1/sync'  })
  await app.register(aiRoutes,   { prefix: '/v1/ai'    })

  return app
}
