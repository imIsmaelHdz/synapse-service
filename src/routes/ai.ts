import { FastifyPluginAsync } from 'fastify'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { loadPrompt } from '../lib/prompt-loader'

// ── Per-user daily generation limit for /suggest ─────────────────────────────
const SUGGEST_DAILY_LIMIT = 3

/**
 * Returns how many /suggest calls the user has made today (UTC date).
 * Creates the counter row if it doesn't exist yet.
 * Uses INSERT … ON CONFLICT DO NOTHING so it's safe under concurrent requests.
 */
async function getSuggestUsageToday(
  client: any,
  uid: string,
): Promise<number> {
  const today = new Date().toISOString().slice(0, 10) // "YYYY-MM-DD"
  await client.query(
    `INSERT INTO ai_usage (uid, date, suggest_count)
     VALUES ($1, $2, 0)
     ON CONFLICT (uid, date) DO NOTHING`,
    [uid, today],
  )
  const { rows } = await client.query(
    `SELECT suggest_count FROM ai_usage WHERE uid = $1 AND date = $2`,
    [uid, today],
  )
  return rows[0]?.suggest_count ?? 0
}

async function incrementSuggestUsage(client: any, uid: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  await client.query(
    `UPDATE ai_usage SET suggest_count = suggest_count + 1
     WHERE uid = $1 AND date = $2`,
    [uid, today],
  )
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')

// ── Model instances ───────────────────────────────────────────────────────────
// /suggest  — gemini-2.5-flash: benefits from deep reasoning to find non-obvious
//             connections across a user's notes.
// /discover — gemini-2.5-flash-lite: simple recommendation task; no thinking overhead,
//             significantly faster cold response (~1-2s vs ~4-6s).

const suggestModel = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash',
  generationConfig: {
    responseMimeType: 'application/json',
    maxOutputTokens: 4096,
  },
})

const discoverModel = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash-lite',
  generationConfig: {
    responseMimeType: 'application/json',
    maxOutputTokens: 300, // single {title, creator, reason} needs ~100 tokens
  },
})

// ── Server-side discover cache ────────────────────────────────────────────────
// Keyed by "title::creator::sourceType::returnType" (all lowercased + trimmed).
// Ignores the per-user `existing` exclusion list for caching — the chance of
// Gemini recommending something the user already has is very low for popular
// titles, and the speed benefit is significant.
//
// TTL  : 24 hours — recommendations are stable over that window
// Max  : 500 entries — each entry is ~200 bytes; total ≤ 100 KB RAM

interface DiscoverCacheEntry {
  item:      DiscoverItem
  expiresAt: number
}

const _discoverCache = new Map<string, DiscoverCacheEntry>()
const CACHE_TTL_MS   = 24 * 60 * 60 * 1000   // 24 h
const CACHE_MAX      = 500

function cacheKey(title: string, creator: string, sourceType: string, returnType: string): string {
  return [title, creator, sourceType, returnType].map((s) => s.trim().toLowerCase()).join('::')
}

function cacheGet(key: string): DiscoverItem | null {
  const entry = _discoverCache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) { _discoverCache.delete(key); return null }
  return entry.item
}

function cacheSet(key: string, item: DiscoverItem): void {
  if (_discoverCache.size >= CACHE_MAX) {
    // Evict the oldest insertion (Map preserves insertion order)
    const firstKey = _discoverCache.keys().next().value
    if (firstKey !== undefined) _discoverCache.delete(firstKey)
  }
  _discoverCache.set(key, { item, expiresAt: Date.now() + CACHE_TTL_MS })
}

// ── /suggest types ────────────────────────────────────────────────────────────

interface Note {
  id:       string
  title:    string
  content:  string
  sourceId?: string  // book/movie/serie/topic id — used for diverse graph sampling
}

interface Suggestion {
  source_note_id: string
  target_note_id: string
  reason:         string
}

const SAMPLE_SIZE = 10    // notes sent to Gemini per request
const MAX_CONTENT = 400   // chars per note

/**
 * Picks `count` notes spread across different books/sources (graph sections).
 * Round-robins across books so no single source dominates the batch.
 * Falls back to a simple random shuffle when bookId is absent.
 */
function sampleDiverse(notes: Note[], count = SAMPLE_SIZE): Note[] {
  if (notes.length <= count) return notes

  // Group by bookId (or a single "unknown" bucket if missing)
  const byBook = new Map<string, Note[]>()
  for (const note of notes) {
    const key = note.sourceId ?? '__unknown__'
    if (!byBook.has(key)) byBook.set(key, [])
    byBook.get(key)!.push(note)
  }

  // Shuffle each bucket so round-robin picks are random within each book
  for (const bucket of byBook.values()) {
    for (let i = bucket.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[bucket[i], bucket[j]] = [bucket[j], bucket[i]]
    }
  }

  const buckets  = [...byBook.values()]
  const pointers = new Array(buckets.length).fill(0)
  const result: Note[] = []

  // Round-robin until we have `count` notes or exhaust all buckets
  let round = 0
  while (result.length < count) {
    let added = false
    for (let b = 0; b < buckets.length && result.length < count; b++) {
      const idx = round * buckets.length + b  // not really — use pointer
      const ptr = pointers[b]
      if (ptr < buckets[b].length) {
        result.push(buckets[b][ptr])
        pointers[b]++
        added = true
      }
    }
    if (!added) break  // all buckets exhausted
    round++
  }

  return result
}

function buildPrompt(notes: Note[]): string {
  const sampled   = sampleDiverse(notes, SAMPLE_SIZE)
  const formatted = sampled
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

    // ── Per-user daily limit ────────────────────────────────────────────────
    const usedToday = await getSuggestUsageToday(client, uid)
    if (usedToday >= SUGGEST_DAILY_LIMIT) {
      return reply.status(429).send({
        statusCode: 429,
        error:      'Daily limit reached',
        message:    `You've used all ${SUGGEST_DAILY_LIMIT} hidden-connection generations for today. Come back tomorrow!`,
      })
    }

    const { notes } = request.body
    const noteIds = new Set(notes.map((n) => n.id))

    let raw: string
    try {
      const result = await suggestModel.generateContent(buildPrompt(notes))

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

    // Count only successful generations
    await incrementSuggestUsage(client, uid)

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

      const sanitise = (o: Record<string, unknown>): DiscoverItem => ({
        title:   String(o['title']   ?? ''),
        creator: String(o['creator'] ?? ''),
        reason:  String(o['reason']  ?? ''),
      })

      // ── Single-item mode (deck UI) ──────────────────────────────────────────
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
          _discoverCache.delete(key)
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
          const start = raw.indexOf('{')
          const end   = raw.lastIndexOf('}')
          if (start === -1 || end === -1) throw new Error('No JSON found')
          const item = sanitise(JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>)
          // 2. Store in cache before returning
          cacheSet(key, item)
          return item
        } catch (parseErr) {
          fastify.log.warn({ raw, parseErr: String(parseErr) }, 'Could not parse /discover single response')
          return reply.internalServerError('Unexpected AI response format')
        }
      }

      // ── Batch mode (legacy) ─────────────────────────────────────────────────
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
