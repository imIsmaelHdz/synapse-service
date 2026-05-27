import fp                           from 'fastify-plugin'
import { FastifyPluginAsync }        from 'fastify'
import admin                         from 'firebase-admin'
import { DecodedIdToken }            from 'firebase-admin/auth'

// Extend Fastify's request type so every route gets `request.user`
declare module 'fastify' {
  interface FastifyRequest {
    user: DecodedIdToken
  }
}

// Routes that don't require a token
const PUBLIC = new Set(['/health'])

const firebasePlugin: FastifyPluginAsync = async (fastify) => {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    })
    fastify.log.info('Firebase Admin SDK initialized')
  }

  fastify.addHook('onRequest', async (request, reply) => {
    if (PUBLIC.has(request.routerPath)) return

    const auth = request.headers.authorization
    if (!auth?.startsWith('Bearer ')) {
      return reply.unauthorized('Missing Bearer token')
    }

    try {
      request.user = await admin.auth().verifyIdToken(auth.slice(7))
    } catch {
      return reply.unauthorized('Invalid or expired token')
    }
  })
}

export default fp(firebasePlugin, { name: 'firebase' })
