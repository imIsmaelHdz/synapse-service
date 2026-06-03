import { loadPrompt } from '../../lib/prompt-loader'
import type { ExistingItem, ExistingLink, Note, ReturnType } from './types'
import { MAX_CONTENT, SAMPLE_SIZE, sampleDiverse } from './sample'

export function buildPrompt(notes: Note[], existingLinks: ExistingLink[] = []): string {
  const sampled   = sampleDiverse(notes, SAMPLE_SIZE)
  const formatted = sampled
    .map((n) => `[${n.id}] ${n.title}\n${n.content.slice(0, MAX_CONTENT)}`)
    .join('\n\n---\n\n')

  // Build exclusion block so Gemini never suggests already-connected pairs
  const exclusionBlock = existingLinks.length > 0
    ? `\n\nDo NOT suggest any of these already-connected pairs:\n` +
      existingLinks
        .map((l) => `- ${l.source_note_id} ↔ ${l.target_note_id}`)
        .join('\n')
    : ''

  return loadPrompt('suggest', { notes: formatted + exclusionBlock })
}

//Single-item prompt (used by the deck UI — one call per card)
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

export function buildDiscoverSinglePrompt(
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

//Batch prompt (legacy — kept for backwards compatibility)

export function buildDiscoverPrompt(title: string, creator: string, type: string, existing: ExistingItem[] = []): string {
  const source = creator
    ? `"${title}" by ${creator} (${type})`
    : `"${title}" (${type})`

  const exclusions = existing.length > 0
    ? `\n\nThe user already has these in their library — do NOT recommend any of them:\n` +
      existing.map((e) => `- "${e.title}"${e.creator ? ` by ${e.creator}` : ''} (${e.type})`).join('\n')
    : ''

  return loadPrompt('discover-batch', { source, exclusions })
}
