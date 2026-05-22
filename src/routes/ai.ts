import { FastifyPluginAsync } from 'fastify'
import Anthropic             from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

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

// Trim note content so we don't blow the context window
const MAX_NOTES   = 60
const MAX_CONTENT = 400   // chars per note

const SYSTEM_PROMPT = `You are a knowledge connection engine for Synapse, a personal knowledge graph app.

Given a list of the user's personal notes, find meaningful semantic connections between them — the kind of non-obvious links that spark new insight. Think like a brilliant friend who has read everything across every field, not a keyword matcher.

Guidelines:
- Prioritise surprising cross-domain connections over obvious same-topic links
- Every suggestion must include a short "Because:" explanation (1-2 sentences) grounded in the actual note content — no generic filler
- Aim for quality over quantity: 3 great suggestions beat 5 weak ones
- Maximum 5 suggestions
- Return only valid JSON, no extra text`

function buildUserPrompt (notes: Note[]): string {
  const formatted = notes
    .slice(0, MAX_NOTES)
    .map((n) => `[${n.id}] ${n.title}\n${n.content.slice(0, MAX_CONTENT)}`)
    .join('\n\n---\n\n')

  return `Here are the user's notes:\n\n${formatted}\n\nReturn JSON in this exact format:
{
  "suggestions": [
    {
      "source_note_id": "uuid",
      "target_note_id": "uuid",
      "reason": "Because..."
    }
  ]
}`
}

/**
 * POST /v1/ai/suggest
 *
 * Flutter sends its local notes array.
 * Claude finds non-obvious semantic connections.
 * Returns suggested links with explanations — the user accepts or dismisses each.
 */
const aiRoutes: FastifyPluginAsync = async (fastify) => {

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

    // Collect note IDs for validation
    const noteIds = new Set(notes.map((n) => n.id))

    let raw: string
    try {
      const message = await client.messages.create({
        model:      'claude-opus-4-5',
        max_tokens: 1024,
        system:     SYSTEM_PROMPT,
        messages:   [{ role: 'user', content: buildUserPrompt(notes) }],
      })

      raw = message.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { type: 'text'; text: string }).text)
        .join('')

    } catch (err) {
      fastify.log.error(err, 'Claude API error')
      return reply.internalServerError('AI service unavailable — try again shortly')
    }

    // Parse Claude's JSON response
    let suggestions: Suggestion[] = []
    try {
      const parsed = JSON.parse(raw)
      suggestions = (parsed.suggestions ?? []).filter(
        (s: Suggestion) =>
          noteIds.has(s.source_note_id) &&
          noteIds.has(s.target_note_id) &&
          s.source_note_id !== s.target_note_id &&
          typeof s.reason === 'string',
      )
    } catch {
      fastify.log.warn({ raw }, 'Could not parse Claude response as JSON')
      return reply.internalServerError('Unexpected AI response format')
    }

    return { suggestions }
  })

}

export default aiRoutes
