import Fastify from 'fastify'
import cors    from '@fastify/cors'
import helmet  from '@fastify/helmet'
import sensible from '@fastify/sensible'

import firebasePlugin from './plugins/firebase'
import postgresPlugin from './plugins/postgres'

import healthRoutes from './routes/health'
import userRoutes   from './routes/users'
import bookRoutes   from './routes/books'
import noteRoutes   from './routes/notes'
import linkRoutes   from './routes/links'
import graphRoutes  from './routes/graph'

export async function buildApp () {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      ...(process.env.NODE_ENV === 'development' && {
        transport: { target: 'pino-pretty' },
      }),
    },
  })

  // ── Security & utilities ──────────────────────────────────────
  await app.register(helmet)
  await app.register(cors, {
    origin: process.env.ALLOWED_ORIGINS?.split(',') ?? '*',
  })
  await app.register(sensible)

  // ── Core plugins ──────────────────────────────────────────────
  await app.register(postgresPlugin)
  await app.register(firebasePlugin)

  // ── Routes ────────────────────────────────────────────────────
  await app.register(healthRoutes)
  await app.register(userRoutes,  { prefix: '/v1/users' })
  await app.register(bookRoutes,  { prefix: '/v1/books' })
  await app.register(noteRoutes,  { prefix: '/v1/notes' })
  await app.register(linkRoutes,  { prefix: '/v1/links' })
  await app.register(graphRoutes, { prefix: '/v1/graph' })

  return app
}
