/**
 * Returns how many /suggest calls the user has made today (UTC date).
 * Creates the counter row if it doesn't exist yet.
 * Uses INSERT … ON CONFLICT DO NOTHING so it's safe under concurrent requests.
 */
export async function getSuggestUsageToday(
  client: any,
  uid: string,
  today: string = new Date().toISOString().slice(0, 10),
): Promise<number> {
  try {
    // Upsert the user row first so the FK constraint never fires
    // (new accounts may not have been synced to `users` yet)
    await client.query(
      `INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
      [uid],
    )
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
  } catch {
    // If ai_usage is unreachable for any reason, allow the request through
    return 0
  }
}

export async function incrementSuggestUsage (
  client: any,
  uid: string,
  today: string = new Date().toISOString().slice(0, 10),
): Promise<void> {
  try {
    await client.query(
      `UPDATE ai_usage SET suggest_count = suggest_count + 1
        WHERE uid = $1 AND date = $2`,
      [uid, today],
    )
  } catch { /* non-fatal */ }
}
