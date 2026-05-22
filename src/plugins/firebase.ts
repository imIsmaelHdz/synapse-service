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

const devAuthBypass =
  process.env.NODE_ENV === 'development' &&
  process.env.DEV_AUTH_BYPASS === 'true'

// Bearer dev:<uid>:<email>:<display_name>
function parseDevToken (token: string): DecodedIdToken | null {
  if (!token.startsWith('dev:')) return null
  const [, uid, email, name] = token.split(':')
  if (!uid) return null
  return { uid, email, name } as unknown as DecodedIdToken
}

const firebasePlugin: FastifyPluginAsync = async (fastify) => {
  if (devAuthBypass) {
    fastify.log.warn('DEV_AUTH_BYPASS enabled — Firebase auth is mocked for local development')
  } else if (!admin.apps.length) {
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

    const token = auth.slice(7)

    if (devAuthBypass) {
      const user = parseDevToken(token)
      if (!user) {
        return reply.unauthorized('Invalid dev token — use Bearer dev:<uid>:<email>:<name>')
      }
      request.user = user
      return
    }

    try {
      request.user = await admin.auth().verifyIdToken(token)
    } catch {
      return reply.unauthorized('Invalid or expired token')
    }
  })
}

export default fp(firebasePlugin, { name: 'firebase' })
