// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Ismael Hernandez

/**
 * Minimal Brevo (Sendinblue) client — just enough to drop a contact into a
 * list. A Brevo automation on that list sends the actual email (same pattern
 * the marketing site's waitlist uses).
 *
 * Configured entirely via env so nothing secret lives in code:
 *   BREVO_API_KEY          — Brevo v3 API key
 *   BREVO_WELCOME_LIST_ID  — numeric id of the "app users" list whose automation
 *                            sends the first-sign-up welcome email
 * If either is unset the feature is a no-op (safe in dev / before configured).
 */

const CONTACTS_URL = 'https://api.brevo.com/v3/contacts'

export function brevoConfigured (): boolean {
  return Boolean(process.env.BREVO_API_KEY && process.env.BREVO_WELCOME_LIST_ID)
}

/**
 * Upsert the contact and add them to the welcome list. updateEnabled means an
 * existing contact (e.g. someone already on the waitlist) is updated and added
 * to the list rather than rejected. Resolves on success; throws on real failure
 * so the caller can decide whether to retry.
 */
export async function addToWelcomeList (
  email: string,
  name: string | null,
): Promise<void> {
  const apiKey = process.env.BREVO_API_KEY!
  const listId = Number(process.env.BREVO_WELCOME_LIST_ID)

  const res = await fetch(CONTACTS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify({
      email,
      listIds: [listId],
      updateEnabled: true,
      ...(name ? { attributes: { FIRSTNAME: name } } : {}),
    }),
  })

  // 201 created · 204 updated — both fine.
  if (res.status === 201 || res.status === 204) return

  // Already a contact: treat as success (the list-add still happened with
  // updateEnabled, but guard the legacy duplicate code path too).
  const data = await res.json().catch(() => ({} as Record<string, unknown>))
  if ((data as { code?: string }).code === 'duplicate_parameter') return

  throw new Error(`Brevo contacts HTTP ${res.status}: ${JSON.stringify(data)}`)
}
