export interface QueryCall {
  sql:    string
  params: unknown[]
}

export class MockPgClient {
  calls: QueryCall[] = []
  private selectCount = 0

  constructor (
    private readonly options: {
      suggestCount?: number | null
      throwOn?:     'any' | 'select' | 'insert'
    } = {},
  ) {}

  async query (sql: string, params: unknown[] = []) {
    this.calls.push({ sql, params })

    if (this.options.throwOn === 'any' ||
        (this.options.throwOn === 'select' && sql.includes('SELECT suggest_count')) ||
        (this.options.throwOn === 'insert' && sql.includes('INSERT INTO ai_usage'))) {
      throw new Error('mock pg error')
    }

    if (sql.includes('SELECT suggest_count')) {
      if (this.options.suggestCount === null) return { rows: [] }
      return { rows: [{ suggest_count: this.options.suggestCount ?? 0 }] }
    }

    return { rows: [] }
  }
}
