import { FastifyInstance } from 'fastify'
import { cacheDelete, cacheGet, cacheKey, cacheSet } from '../discover-cache'
import { discoverModel } from '../gemini'
import { buildDiscoverPrompt, buildDiscoverSinglePrompt } from '../prompt-builders'
import {
  parseDiscoverBatchResult,
  parseGeminiJsonObject,
  sanitiseDiscoverItem,
} from '../gemini-json'
import type { ExistingItem, ReturnType } from '../types'

export function registerDiscoverRoute (fastify: FastifyInstance) {
  /**
   * POST /v1/ai/discover
   *
   * Flutter sends a source item from the user's library.
   * Gemini returns one book, one movie, and one podcast/video recommendation
   * with a "Because:" explanation for each.
   */
  fastify.post<{
    Body: {
      title: string
      creator: string
      type: string
      existing?: ExistingItem[]
      returnType?: ReturnType
      forceRefresh?: boolean
    }
  }>(
    '/discover',
    {
      config: {
        rateLimit: { max: 20, timeWindow: '1 minute' }, // protect Gemini costs
      },
      schema: {
        body: {
          type: 'object',
          required: ['title', 'type'],
          properties: {
            title:      { type: 'string', minLength: 1, maxLength: 300 },
            creator:    { type: 'string', maxLength: 200, default: '' },
            type:       { type: 'string', maxLength: 50 },
            returnType: { type: 'string', enum: ['book', 'movie', 'serie'] },
            existing: {
              type: 'array',
              maxItems: 200,
              default: [],
              items: {
                type: 'object',
                required: ['title', 'type'],
                properties: {
                  title:   { type: 'string' },
                  creator: { type: 'string', default: '' },
                  type:    { type: 'string' },
                },
              },
            },
            forceRefresh: { type: 'boolean', default: false },
          },
        },
      },
    },
    async (request, reply) => {
      const { title, creator = '', type, existing = [], returnType, forceRefresh = false } = request.body

      //Single-item mode (deck UI)
      if (returnType) {
        // 1. Check server-side cache — skip when forceRefresh=true (manual refresh)
        const key = cacheKey(title, creator, type, returnType)
        if (!forceRefresh) {
          const cached = cacheGet(key)
          if (cached) {
            fastify.log.debug({ key }, 'discover cache hit')
            return cached
          }
        } else {
          fastify.log.debug({ key }, 'discover cache bypassed (forceRefresh)')
          cacheDelete(key)
        }

        let raw: string
        try {
          const result = await discoverModel.generateContent(
            buildDiscoverSinglePrompt(title, creator, type, returnType, existing),
          )
          const candidate = result.response.candidates?.[0]
          const finishReason = candidate?.finishReason ?? 'STOP'
          if (finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
            throw new Error(`unexpected finishReason: ${finishReason}`)
          }
          raw = result.response.text()
        } catch (err) {
          fastify.log.error(err, 'Gemini API error in /discover single')
          return reply.internalServerError('AI service unavailable — try again shortly')
        }

        try {
          const item = sanitiseDiscoverItem(parseGeminiJsonObject(raw))
          // 2. Store in cache before returning
          cacheSet(key, item)
          return item
        } catch (parseErr) {
          fastify.log.warn({ raw, parseErr: String(parseErr) }, 'Could not parse /discover single response')
          return reply.internalServerError('Unexpected AI response format')
        }
      }

      //Batch mode (legacy)
      let raw: string
      try {
        const result = await discoverModel.generateContent(
          buildDiscoverPrompt(title, creator, type, existing),
        )
        const candidate = result.response.candidates?.[0]
        const finishReason = candidate?.finishReason ?? 'STOP'
        if (finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
          throw new Error(`unexpected finishReason: ${finishReason}`)
        }
        raw = result.response.text()
      } catch (err) {
        fastify.log.error(err, 'Gemini API error in /discover')
        return reply.internalServerError('AI service unavailable — try again shortly')
      }

      try {
        fastify.log.info({ rawLength: raw.length, rawPreview: raw.slice(0, 200) }, 'Gemini /discover raw response')
        return parseDiscoverBatchResult(parseGeminiJsonObject(raw))
      } catch (parseErr) {
        fastify.log.warn({ raw, parseErr: String(parseErr) }, 'Could not parse /discover response')
        return reply.internalServerError('Unexpected AI response format')
      }
    },
  )
}
