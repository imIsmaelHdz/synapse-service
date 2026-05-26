import { FastifyPluginAsync } from 'fastify'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { loadPrompt } from '../lib/prompt-loader'

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')

// ── /suggest types ────────────────────────────────────────────────────────────

interface Note {
  id:      string
  title:   string
  content: string
}

interface Suggestion {
  source_note_id: string
  target_note_id: string
  reason:         string
}

const MAX_NOTES   = 60
const MAX_CONTENT = 400   // chars per note

function buildPrompt(notes: Note[]): string {
  const formatted = notes
    .slice(0, MAX_NOTES)
    .map((n) => `[${n.id}] ${n.title}\n${n.content.slice(0, MAX_CONTENT)}`)
    .join('\n\n---\n\n')

  return loadPrompt('suggest', { notes: formatted })
}

// ── /discover types ───────────────────────────────────────────────────────────

interface DiscoverItem {
  title:   string
  creator: string
  reason:  string
}

interface DiscoverResult {
  book:  DiscoverItem
  movie: DiscoverItem
  serie: DiscoverItem
}

interface ExistingItem {
  title:   string
  creator: string
  type:    string
}

type ReturnType = 'book' | 'movie' | 'serie'

// ── Single-item prompt (used by the deck UI — one call per card) ──────────────

const TYPE_LABELS: Record<ReturnType, string> = {
  book:  'book (real, published, findable)',
  movie: 'movie (real, released, findable)',
  serie: 'podcast episode or YouTube video (real, findable online)',
}

const CREATOR_LABELS: Record<ReturnType, string> = {
  book:  'Author name',
  movie: 'Director name',
  serie: 'Channel or host name',
}

function buildDiscoverSinglePrompt(
  title: string,
  creator: string,
  sourceType: string,
  returnType: ReturnType,
  existing: ExistingItem[] = [],
): string {
  const source = creator
    ? `"${title}" by ${creator} (${sourceType})`
    : `"${title}" (${sourceType})`

  const exclusions = existing.length > 0
    ? `\n\nDo NOT recommend any of these (already in the user's library):\n` +
      existing.map((e) => `- "${e.title}"${e.creator ? ` by ${e.creator}` : ''} (${e.type})`).join('\n')
    : ''

  return loadPrompt('discover-single', {
    returnTypeLabel: TYPE_LABELS[returnType],
    source,
    exclusions,
    creatorLabel: CREATOR_LABELS[returnType],
  })
}

// ── Batch prompt (legacy — kept for backwards compatibility) ──────────────────

function buildDiscoverPrompt(title: string, creator: string, type: string, existing: ExistingItem[] = []): string {
  const source = creator
    ? `"${title}" by ${creator} (${type})`
    : `"${title}" (${type})`

  const exclusions = existing.length > 0
    ? `\n\nThe user already has these in their library — do NOT recommend any of them:\n` +
      existing.map((e) => `- "${e.title}"${e.creator ? ` by ${e.creator}` : ''} (${e.type})`).join('\n')
    : ''

  return loadPrompt('discover-batch', { source, exclusions })
}

// ── Route plugin ──────────────────────────────────────────────────────────────

const aiRoutes: FastifyPluginAsync = async (fastify) => {

  /**
   * POST /v1/ai/suggest
   *
   * Flutter sends its local notes array.
   * Gemini finds non-obvious semantic connections.
   * Returns suggested links with explanations — the user accepts or dismisses each.
   */
  fastify.post<{ Body: { notes: Note[] } }>('/suggest', {
    schema: {
      body: {
        type: 'object',
        required: ['notes'],
        properties: {
          notes: {
            type:     'array',
            minItems: 2,
            maxItems: MAX_NOTES,
            items: {
              type:     'object',
              required: ['id', 'title', 'content'],
              properties: {
                id:      { type: 'string' },
                title:   { type: 'string' },
                content: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {

    const { notes } = request.body
    const noteIds = new Set(notes.map((n) => n.id))

    let raw: string
    try {
      const model = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: 4096,
        },
      })

      const result = await model.generateContent(buildPrompt(notes))

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

    let suggestions: Suggestion[] = []
    try {
      const start = raw.indexOf('{')
      const end   = raw.lastIndexOf('}')
      if (start === -1 || end === -1) throw new Error('No JSON object found')
      const parsed = JSON.parse(raw.slice(start, end + 1))
      suggestions = (parsed.suggestions ?? [])
        .filter(
          (s: Suggestion) =>
            noteIds.has(s.source_note_id) &&
            noteIds.has(s.target_note_id) &&
            s.source_note_id !== s.target_note_id &&
            typeof s.reason === 'string',
        )
        .slice(0, 3)
    } catch (parseErr) {
      fastify.log.warn({ raw, parseErr: String(parseErr) }, 'Could not parse Gemini response as JSON')
      return reply.internalServerError('Unexpected AI response format')
    }

    return { suggestions }
  })

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
    }
  }>(
    '/discover',
    {
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
          },
        },
      },
    },
    async (request, reply) => {
      const { title, creator = '', type, existing = [], returnType } = request.body

      const sanitise = (o: Record<string, unknown>): DiscoverItem => ({
        title:   String(o['title']   ?? ''),
        creator: String(o['creator'] ?? ''),
        reason:  String(o['reason']  ?? ''),
      })

      const geminiCall = async (prompt: string) => {
        const model = genAI.getGenerativeModel({
          model: 'gemini-2.5-flash',
          generationConfig: {
            responseMimeType: 'application/json',
            maxOutputTokens: 4096,
          },
        })
        const result = await model.generateContent(prompt)
        const candidate = result.response.candidates?.[0]
        const finishReason = candidate?.finishReason ?? 'STOP'
        if (finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
          throw new Error(`unexpected finishReason: ${finishReason}`)
        }
        return result.response.text()
      }

      // ── Single-item mode (deck UI) ──────────────────────────────────────────
      if (returnType) {
        let raw: string
        try {
          raw = await geminiCall(
            buildDiscoverSinglePrompt(title, creator, type, returnType, existing),
          )
        } catch (err) {
          fastify.log.error(err, 'Gemini API error in /discover single')
          return reply.internalServerError('AI service unavailable — try again shortly')
        }

        try {
          const start = raw.indexOf('{')
          const end   = raw.lastIndexOf('}')
          if (start === -1 || end === -1) throw new Error('No JSON found')
          const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
          return sanitise(parsed)
        } catch (parseErr) {
          fastify.log.warn({ raw, parseErr: String(parseErr) }, 'Could not parse /discover single response')
          return reply.internalServerError('Unexpected AI response format')
        }
      }

      // ── Batch mode (legacy) ─────────────────────────────────────────────────
      let raw: string
      try {
        raw = await geminiCall(buildDiscoverPrompt(title, creator, type, existing))
      } catch (err) {
        fastify.log.error(err, 'Gemini API error in /discover')
        return reply.internalServerError('AI service unavailable — try again shortly')
      }

      try {
        fastify.log.info({ rawLength: raw.length, rawPreview: raw.slice(0, 200) }, 'Gemini /discover raw response')
        const start = raw.indexOf('{')
        const end   = raw.lastIndexOf('}')
        if (start === -1 || end === -1) throw new Error('No JSON object found')
        const parsed = JSON.parse(raw.slice(start, end + 1))

        const discoverResult: DiscoverResult = {
          book:  sanitise(parsed['book']  as Record<string, unknown> ?? {}),
          movie: sanitise(parsed['movie'] as Record<string, unknown> ?? {}),
          serie: sanitise(parsed['serie'] as Record<string, unknown> ?? {}),
        }
        return discoverResult
      } catch (parseErr) {
        fastify.log.warn({ raw, parseErr: String(parseErr) }, 'Could not parse /discover response')
        return reply.internalServerError('Unexpected AI response format')
      }
    },
  )

}

export default aiRoutes
