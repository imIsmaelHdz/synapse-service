import 'dotenv/config'
import { buildApp } from './app'

const start = async () => {
  const app = await buildApp()

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
