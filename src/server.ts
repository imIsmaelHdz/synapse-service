import 'dotenv/config'
import { buildApp } from './app'

// ── Required environment variables ────────────────────────────────────────────
// Fail fast at boot so Railway surfaces the problem immediately rather than
// letting the first request trigger a cryptic runtime error.
function validateEnv () {
  const required: Record<string, string> = {
    DATABASE_URL:          'PostgreSQL connection string',
    DB_ENCRYPTION_KEY:     '64-char hex key — generate: openssl rand -hex 32',
    GEMINI_API_KEY:        'Google AI API key',
    FIREBASE_PROJECT_ID:   'Firebase project ID',
    FIREBASE_CLIENT_EMAIL: 'Firebase service account email',
    FIREBASE_PRIVATE_KEY:  'Firebase service account private key',
  }

  const missing = Object.entries(required)
    .filter(([k]) => !process.env[k])
    .map(([k, hint]) => `  ${k}  →  ${hint}`)

  if (missing.length) {
    console.error('❌  Missing required environment variables:\n' + missing.join('\n'))
    process.exit(1)
  }

  if ((process.env.DB_ENCRYPTION_KEY as string).length !== 64) {
    console.error('❌  DB_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).')
    process.exit(1)
  }
}

const start = async () => {
  validateEnv()

  const app = await buildApp()

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  // Railway sends SIGTERM before killing the container. Close the server so
  // in-flight sync pushes and AI calls can finish before the process exits.
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Shutting down gracefully…')
    try {
      await app.close()
      process.exit(0)
    } catch (err) {
      app.log.error(err, 'Error during shutdown')
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)) })
  process.on('SIGINT',  () => { shutdown('SIGINT').catch(() => process.exit(1)) })

  try {
    const port = parseInt(process.env.PORT ?? '3000', 10)
    const host = process.env.HOST ?? '0.0.0.0'
    await app.listen({ port, host })
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
