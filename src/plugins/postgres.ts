import fp       from 'fastify-plugin'
import postgres  from '@fastify/postgres'

export default fp(async (fastify) => {
  fastify.register(postgres, {
    connectionString: process.env.DATABASE_URL,
  })
}, { name: 'postgres' })
