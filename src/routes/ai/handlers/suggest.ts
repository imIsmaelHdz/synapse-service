// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

import { FastifyInstance } from 'fastify'
import { SUGGEST_DAILY_LIMIT } from '../../../config/ai'
import { suggestModel } from '../gemini'
import { buildPrompt } from '../prompt-builders'
import { normalizeSuggestions, parseGeminiJsonObject } from '../gemini-json'
import type { ExistingLink, Note } from '../types'
import { getSuggestUsageToday, incrementSuggestUsage } from '../usage'

export function registerSuggestRoute (fastify: FastifyInstance) {
  /**
   * POST /v1/ai/suggest
   *
   * Flutter sends its local notes array.
   * Gemini finds non-obvious semantic connections.
   * Returns suggested links with explanations — the user accepts or dismisses each.
   */
  fastify.post<{ Body: { notes: Note[], existingLinks?: ExistingLink[] } }>('/suggest', {
    config: {
      rateLimit: { max: 20, timeWindow: '1 minute' }, // protect Gemini costs
    },
    schema: {
      body: {
        type: 'object',
        required: ['notes'],
        properties: {
          notes: {
            type:     'array',
            minItems: 2,
            maxItems: 500,  // accept full graph; sampling to 10 happens server-side
            items: {
              type:     'object',
              required: ['id', 'title', 'content'],
              properties: {
                id:       { type: 'string' },
                title:    { type: 'string' },
                content:  { type: 'string' },
                sourceId: { type: 'string' }, // book/movie/serie/topic id
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {

    const { uid } = (request as any).user
    const client  = (fastify as any).pg

    // Per-user daily limit
    const usedToday = await getSuggestUsageToday(client, uid)
    if (usedToday >= SUGGEST_DAILY_LIMIT) {
      return reply.status(429).send({
        statusCode: 429,
        error:      'Daily limit reached',
        message:    `You've used all ${SUGGEST_DAILY_LIMIT} hidden-connection generations for today. Come back tomorrow!`,
      })
    }

    const { notes, existingLinks = [] } = request.body
    const noteIds = new Set(notes.map((n) => n.id))

    let raw: string
    try {
      const result = await suggestModel.generateContent(buildPrompt(notes, existingLinks))

      const candidate = result.response.candidates?.[0]
      const finishReason = candidate?.finishReason ?? 'STOP'
      if (finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
        fastify.log.warn({ finishReason }, 'Gemini /suggest unexpected finishReason')
        return reply.internalServerError('AI service unavailable — try again shortly')
      }

      raw = result.response.text()

    } catch (err) {
      fastify.log.error(err, 'Gemini API error')
      return reply.internalServerError('AI service unavailable — try again shortly')
    }

    let suggestions
    try {
      suggestions = normalizeSuggestions(parseGeminiJsonObject(raw), noteIds)
    } catch (parseErr) {
      fastify.log.warn({ raw, parseErr: String(parseErr) }, 'Could not parse Gemini response as JSON')
      return reply.internalServerError('Unexpected AI response format')
    }

    // Count only successful generations
    await incrementSuggestUsage(client, uid)

    return { suggestions }
  })
}
