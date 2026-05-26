import { FastifyPluginAsync } from 'fastify'
import { GoogleGenerativeAI } from '@google/generative-ai'

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

const SYSTEM_PROMPT = `You are a knowledge connection engine for Synapse, a personal knowledge graph app.

Given a list of the user's personal notes, find meaningful semantic connections between them — the kind of non-obvious links that spark new insight. Think like a brilliant friend who has read everything across every field, not a keyword matcher.

Guidelines:
- Suggest EXACTLY 3 connections — no more, no fewer
- Prioritise surprising cross-domain connections over obvious same-topic links
- Every suggestion must include a short "Because:" explanation (1-2 sentences) grounded in the actual note content — no generic filler
- Write the "reason" field in the same language the notes are written in (detect from the note titles and content)
- Return only valid JSON, no extra text`

function buildPrompt(notes: Note[]): string {
  const formatted = notes
    .slice(0, MAX_NOTES)
    .map((n) => `[${n.id}] ${n.title}\n${n.content.slice(0, MAX_CONTENT)}`)
    .join('\n\n---\n\n')

  return `${SYSTEM_PROMPT}

Here are the user's notes:

${formatted}

Return ONLY this JSON structure, no markdown, no code fences, no extra text:
{
  "suggestions": [
    {
      "source_note_id": "the-exact-note-id",
      "target_note_id": "the-exact-note-id",
      "reason": "Because..."
    }
  ]
}`
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

  return `You are a deep-media recommendation engine for Synapse, a personal knowledge graph app.

Your task: recommend ONE ${TYPE_LABELS[returnType]} that shares the *soul* of the source — its themes, emotional tone, cultural DNA, and narrative texture. Never match on surface keywords or proper nouns.

Before choosing, silently analyse the source across these dimensions:
• Real genre / subgenre (e.g. "shonen anime", "Roman epic", "Stoic philosophy", "psychological thriller")
• Core themes (e.g. "grief driving duty", "corruption of power vs personal honour", "coming-of-age through loss")
• Emotional tone (e.g. "intense and bittersweet", "epic and tragic", "melancholic and introspective")
• Cultural / historical context (e.g. "Taisho-era Japan, samurai ethos, Japanese folklore")
• Narrative structure (e.g. "hero's journey fuelled by revenge", "fall-from-grace arc")

Recommend based on that analysis — NEVER on shared words in the title.

❌ WRONG — "The Exorcist" for "Demon Slayer: Kimetsu no Yaiba" (matched the word "demon")
✅ RIGHT  — "Kagurabachi" for "Demon Slayer" (both: shonen manga, samurai-era Japan, protagonist driven by grief over a slain parent, intense visual artistry, duty vs personal loss)

❌ WRONG — "Gladiator" → "300" (same genre, obvious pick)
✅ RIGHT  — "Gladiator" → "Meditations" by Marcus Aurelius (both: Roman Stoic worldview, honour and duty under tyranny, a man stripped of everything who finds meaning through integrity)

Rules:
- Must be a REAL, published / released, findable ${TYPE_LABELS[returnType]}
- The "Because:" must cite specific shared themes or emotional DNA — never generic phrases like "explores similar themes" or "fans of X will enjoy"
- Write in the same language as the source title
- Return ONLY valid JSON, no markdown, no extra text

Source: ${source}${exclusions}

Return ONLY: {"title": "...", "creator": "${CREATOR_LABELS[returnType]}", "reason": "Because..."}`
}

// ── Batch prompt (legacy — kept for backwards compatibility) ──────────────────

const DISCOVER_SYSTEM_PROMPT = `You are a deep-media recommendation engine for Synapse, a personal knowledge graph app.

Given a source from the user's library, recommend three items — one book, one movie, one podcast/video — that share the *soul* of the source: its themes, emotional tone, cultural context, and narrative DNA. Never match on surface keywords or proper nouns.

Before choosing, silently analyse the source:
• Real genre / subgenre (e.g. "shonen anime", "Roman epic", "Stoic philosophy")
• Core themes (e.g. "grief driving duty", "corruption of power vs personal honour")
• Emotional tone (e.g. "intense and bittersweet", "epic and tragic")
• Cultural / historical context (e.g. "Taisho-era Japan, samurai ethos")
• Narrative structure (e.g. "hero's journey fuelled by revenge")

Recommend based on that analysis — NEVER on shared words in the title.

❌ WRONG — "The Exorcist" for "Demon Slayer" (matched the word "demon")
✅ RIGHT  — "Kagurabachi" for "Demon Slayer" (both: shonen, samurai-era Japan, protagonist driven by grief over a slain parent)

❌ WRONG — "Gladiator" → "300" (obvious same-genre pick)
✅ RIGHT  — "Gladiator" → "Meditations" by Marcus Aurelius (Roman Stoic worldview, honour under tyranny, integrity through loss)

Rules:
- All three items must be REAL, published / released, findable
- Each "Because:" must cite specific shared themes or emotional DNA — no generic filler
- Use the same language as the source
- Return ONLY valid JSON, no markdown, no code fences, no extra text`

function buildDiscoverPrompt(title: string, creator: string, type: string, existing: ExistingItem[] = []): string {
  const source = creator
    ? `"${title}" by ${creator} (${type})`
    : `"${title}" (${type})`

  const exclusions = existing.length > 0
    ? `\n\nThe user already has these in their library — do NOT recommend any of them:\n` +
      existing.map((e) => `- "${e.title}"${e.creator ? ` by ${e.creator}` : ''} (${e.type})`).join('\n')
    : ''

  return `${DISCOVER_SYSTEM_PROMPT}

The user's source item: ${source}${exclusions}

Return ONLY this JSON structure:
{
  "book":  { "title": "...", "creator": "Author name",  "reason": "Because..." },
  "movie": { "title": "...", "creator": "Director name", "reason": "Because..." },
  "serie": { "title": "...", "creator": "Channel or host name", "reason": "Because..." }
}`
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
