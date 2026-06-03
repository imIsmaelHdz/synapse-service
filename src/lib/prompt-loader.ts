// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

import fs   from 'fs'
import path from 'path'

const PROMPTS_DIR = path.join(__dirname, '../prompts')

// Cache so files are only read once per process lifetime
const cache = new Map<string, string>()

/**
 * Loads a prompt from `src/prompts/<name>.md`, strips YAML frontmatter,
 * replaces all `{{variable}}` placeholders, and returns the final string.
 *
 * Files are read once at first call and cached in memory — no runtime I/O
 * after warm-up, and no need for async/await in callers.
 */
export function loadPrompt(name: string, vars: Record<string, string> = {}): string {
  if (!cache.has(name)) {
    const filePath = path.join(PROMPTS_DIR, `${name}.md`)
    let raw = fs.readFileSync(filePath, 'utf-8')
    // Strip YAML frontmatter block (--- ... ---)
    raw = raw.replace(/^---[\s\S]*?---\n?/, '')
    cache.set(name, raw)
  }

  let prompt = cache.get(name)!

  for (const [key, value] of Object.entries(vars)) {
    prompt = prompt.replaceAll(`{{${key}}}`, value)
  }

  return prompt.trim()
}
