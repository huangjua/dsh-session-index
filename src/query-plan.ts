/** Shared substring query semantics for SQLite and original-log search. */
export type QueryMode = 'and' | 'or'

export interface QueryPlan {
  query: string
  tokens: string[]
}

/** Hermes-compatible query cleaning, kept independent of the storage backend. */
export function sanitizeFts5Query(raw: string): string {
  let q = (raw || '').trim()
  if ((q.match(/"/g) ?? []).length % 2 !== 0) q = q.replace(/"/g, '')
  q = q.replace(/^(AND|OR|NOT)\s+/i, '').replace(/\s+(AND|OR|NOT)$/i, '')
  q = q.replace(/(^|\s)(\w+-\w+)(?=\s|$)/g, (_, pre: string, term: string) => `${pre}"${term}"`)
  return q.replace(/[()*^:[\]]/g, ' ').trim()
}

export function createQueryPlan(raw: string): QueryPlan {
  const tokens = sanitizeFts5Query(raw).split(/\s+/)
    .map(token => token.replace(/^"+|"+$/g, '').replace(/>>>/g, '»').replace(/<<</g, '«'))
    .filter(Boolean)
  return { query: tokens.join(' '), tokens }
}

export function matchesQuery(text: string, plan: QueryPlan, mode: QueryMode = 'and'): boolean {
  if (plan.tokens.length === 0) return false
  const lower = text.replace(/>>>/g, '»').replace(/<<</g, '«').toLowerCase()
  const contains = (token: string): boolean => lower.includes(token.toLowerCase())
  return mode === 'and' ? plan.tokens.every(contains) : plan.tokens.some(contains)
}

/** The earliest matched term supplies the excerpt; matching still uses every term. */
export function queryMatchToken(text: string, plan: QueryPlan): string {
  const lower = text.toLowerCase()
  let best = Number.POSITIVE_INFINITY
  let found = ''
  for (const token of plan.tokens) {
    const index = lower.indexOf(token.toLowerCase())
    if (index >= 0 && index < best) { best = index; found = token }
  }
  return found
}
