import Fastify     from 'fastify'
import cors        from '@fastify/cors'
import helmet      from '@fastify/helmet'
import sensible    from '@fastify/sensible'
import rateLimit   from '@fastify/rate-limit'

import firebasePlugin from './plugins/firebase'
import postgresPlugin from './plugins/postgres'

import healthRoutes from './routes/health'
import userRoutes   from './routes/users'
import syncRoutes   from './routes/sync'
import aiRoutes     from './routes/ai'

export async function buildApp () {
  // In production, never allow log level below 'info' — debug/trace logs can
  // leak request bodies and note content.
  const isProd    = process.env.NODE_ENV === 'production'
  const logLevel  = isProd
    ? 'info'                                        // floor in prod
    : (process.env.LOG_LEVEL ?? 'info')             // dev can lower freely

  const app = Fastify({
    logger: {
      level: logLevel,
      ...(process.env.NODE_ENV === 'development' && {
        transport: { target: 'pino-pretty' },
      }),
    },
  })

  // ── Security headers ────────────────────────────────────────────────────────
  await app.register(helmet)

  // ── CORS ────────────────────────────────────────────────────────────────────
  // Only the Flutter mobile app calls this API — it is not a browser client,
  // so CORS is irrelevant for it. Setting origin: false blocks all browser-based
  // cross-origin requests. No legitimate browser client exists right now.
  // If a web app is ever added, replace false with ['https://thesynapsetool.com'].
  await app.register(cors, {
    origin: false,
  })

  // ── Rate limiting ────────────────────────────────────────────────────────────
  // Global: 200 req / minute.
  // Key: user UID when authenticated (avoids shared-IP collateral damage on
  // mobile hotspots), falling back to IP for unauthenticated paths.
  // AI routes override max with a tighter limit (see routes/ai.ts).
  await app.register(rateLimit, {
    global:     true,
    max:        200,
    timeWindow: '1 minute',
    keyGenerator: (request) => {
      // request.user is set by the Firebase auth hook on protected routes
      const uid = (request as any).user?.uid as string | undefined
      return uid ?? request.ip
    },
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error:      'Too Many Requests',
      message:    `Rate limit exceeded — retry after ${context.after}`,
    }),
  })

  await app.register(sensible)
  await app.register(postgresPlugin)
  await app.register(firebasePlugin)

  // ── Global error handler ────────────────────────────────────────────────────
  // Logs the real error server-side; returns a sanitised response to the client.
  // Prevents raw PostgreSQL error messages (constraint names, table names, etc.)
  // from leaking into API responses in production.
  app.setErrorHandler((error, request, reply) => {
    const status = error.statusCode ?? 500

    // Always log the full error for observability
    request.log.error({ err: error, url: request.url, method: request.method }, 'request error')

    if (status >= 500) {
      return reply.status(500).send({
        statusCode: 500,
        error:      'Internal Server Error',
        message:    process.env.NODE_ENV === 'development'
          ? error.message
          : 'An unexpected error occurred — please try again',
      })
    }

    // 4xx errors are safe to forward (validation failures, auth errors, etc.)
    return reply.status(status).send({
      statusCode: status,
      error:      error.name,
      message:    error.message,
    })
  })

  // ── Routes ──────────────────────────────────────────────────────────────────
  await app.register(healthRoutes)
  await app.register(userRoutes, { prefix: '/v1/users' })
  await app.register(syncRoutes, { prefix: '/v1/sync'  })
  await app.register(aiRoutes,   { prefix: '/v1/ai'    })

  return app
}
