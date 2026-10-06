import { useRef, useState } from 'react'
import { cellFilter, countFeatures, fetchFeatures, type GeoconnexFeature } from '../lib/geoconnex'
import type { GridCell, GridKind } from '../lib/grids'

export const PAGE_SIZE = 50

export interface CellQuery {
  cell: GridCell
  filter: string
  /** undefined while loading, null if the server didn't report a count */
  count: number | null | undefined
  countError?: string
  features: GeoconnexFeature[]
  hasNext: boolean
  loading: boolean
  error?: string
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function useCellQueries() {
  const [queries, setQueries] = useState<Partial<Record<GridKind, CellQuery>>>({})
  const controllers = useRef<Partial<Record<GridKind, AbortController>>>({})

  const update = (kind: GridKind, ac: AbortController, fn: (q: CellQuery) => CellQuery) => {
    if (controllers.current[kind] !== ac) return
    setQueries((qs) => (qs[kind] ? { ...qs, [kind]: fn(qs[kind]) } : qs))
  }

  const run = (cell: GridCell) => {
    const kind = cell.kind
    controllers.current[kind]?.abort()
    const ac = new AbortController()
    controllers.current[kind] = ac
    const filter = cellFilter(cell.ring)
    setQueries((qs) => ({
      ...qs,
      [kind]: { cell, filter, count: undefined, features: [], hasNext: false, loading: true },
    }))
    countFeatures(filter, ac.signal)
      .then((count) => update(kind, ac, (q) => ({ ...q, count })))
      .catch((err) => !isAbort(err) && update(kind, ac, (q) => ({ ...q, count: null, countError: message(err) })))
    fetchFeatures(filter, { limit: PAGE_SIZE, offset: 0 }, ac.signal)
      .then((page) => update(kind, ac, (q) => ({ ...q, features: page.features, hasNext: page.hasNext, loading: false })))
      .catch((err) => !isAbort(err) && update(kind, ac, (q) => ({ ...q, loading: false, error: message(err) })))
  }

  const loadMore = (kind: GridKind) => {
    const q = queries[kind]
    const ac = controllers.current[kind]
    if (!q || !ac || q.loading) return
    setQueries((qs) => ({ ...qs, [kind]: { ...q, loading: true, error: undefined } }))
    fetchFeatures(q.filter, { limit: PAGE_SIZE, offset: q.features.length }, ac.signal)
      .then((page) =>
        update(kind, ac, (cur) => ({ ...cur, features: [...cur.features, ...page.features], hasNext: page.hasNext, loading: false })),
      )
      .catch((err) => !isAbort(err) && update(kind, ac, (cur) => ({ ...cur, loading: false, error: message(err) })))
  }

  const clear = (kind: GridKind) => {
    controllers.current[kind]?.abort()
    delete controllers.current[kind]
    setQueries((qs) => {
      const next = { ...qs }
      delete next[kind]
      return next
    })
  }

  return { queries, run, loadMore, clear }
}
