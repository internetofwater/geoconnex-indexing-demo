import type { Geometry } from 'geojson'
import { useEffect, useRef, useState } from 'react'
import type { GridAnalysis } from '../lib/analysis'
import { AnalysisClient } from '../lib/analysisClient'
import { fetchFeatureByIri, type GeoconnexFeature } from '../lib/geoconnex'
import { GRID_KINDS, type GridKind } from '../lib/grids'

export type LookupStatus =
  | { state: 'idle' }
  | { state: 'loading'; iri: string }
  | { state: 'error'; message: string }
  | { state: 'notfound'; iri: string }
  | { state: 'ready' }

export type AnalysisState =
  | { state: 'running'; previous?: GridAnalysis }
  | { state: 'done'; analysis: GridAnalysis }
  | { state: 'error'; message: string }

export const DEFAULT_N = 13
/** Geohash tops out at precision 12; 8 (~38 × 19 m) is a comparable everyday choice. */
export const DEFAULT_GEOHASH_N = 8

export function useIriAnalysis() {
  const [status, setStatus] = useState<LookupStatus>({ state: 'idle' })
  const [feature, setFeature] = useState<GeoconnexFeature | null>(null)
  const [levels, setLevels] = useState<Record<GridKind, number>>({ s2: DEFAULT_N, h3: DEFAULT_N, geohash: DEFAULT_GEOHASH_N })
  const [results, setResults] = useState<Partial<Record<GridKind, AnalysisState>>>({})
  const clients = useRef<Partial<Record<GridKind, AnalysisClient>>>({})
  const lookup = useRef<AbortController | null>(null)
  const debounce = useRef<Partial<Record<GridKind, ReturnType<typeof setTimeout>>>>({})

  useEffect(() => {
    const cs = clients.current
    return () => GRID_KINDS.forEach((k) => cs[k]?.dispose())
  }, [])

  const analyze = (kind: GridKind, geometry: Geometry, level: number) => {
    const client = (clients.current[kind] ??= new AnalysisClient(kind))
    setResults((rs) => {
      const prev = rs[kind]
      return { ...rs, [kind]: { state: 'running', previous: prev?.state === 'done' ? prev.analysis : prev?.state === 'running' ? prev.previous : undefined } }
    })
    client
      .run(geometry, level)
      .then((analysis) => setResults((rs) => ({ ...rs, [kind]: { state: 'done', analysis } })))
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setResults((rs) => ({ ...rs, [kind]: { state: 'error', message: err instanceof Error ? err.message : String(err) } }))
      })
  }

  /** Fetch the feature and start both analyses; resolves to the feature if found. */
  const load = async (iri: string): Promise<GeoconnexFeature | null> => {
    const trimmed = iri.trim()
    if (!trimmed) return null
    lookup.current?.abort()
    const ac = new AbortController()
    lookup.current = ac
    setStatus({ state: 'loading', iri: trimmed })
    try {
      const f = await fetchFeatureByIri(trimmed, ac.signal)
      if (ac.signal.aborted) return null
      if (!f) {
        setFeature(null)
        setResults({})
        setStatus({ state: 'notfound', iri: trimmed })
        return null
      }
      if (!f.geometry) {
        setFeature(null)
        setResults({})
        setStatus({ state: 'error', message: 'Feature has no geometry' })
        return null
      }
      setFeature(f)
      setStatus({ state: 'ready' })
      setResults({})
      GRID_KINDS.forEach((k) => analyze(k, f.geometry, levels[k]))
      return f
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) })
      }
      return null
    }
  }

  const setLevel = (kind: GridKind, level: number) => {
    setLevels((ls) => ({ ...ls, [kind]: level }))
    if (!feature) return
    clearTimeout(debounce.current[kind])
    const geometry = feature.geometry
    debounce.current[kind] = setTimeout(() => analyze(kind, geometry, level), 120)
  }

  const clear = () => {
    lookup.current?.abort()
    GRID_KINDS.forEach((k) => {
      clearTimeout(debounce.current[k])
      clients.current[k]?.dispose()
    })
    setFeature(null)
    setResults({})
    setStatus({ state: 'idle' })
  }

  return { status, feature, levels, results, load, setLevel, clear }
}
