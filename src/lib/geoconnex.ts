import type { Feature, FeatureCollection, Geometry } from 'geojson'
import type { LngLat } from './geo'

export const ITEMS_URL = 'https://features.geoconnex.us/collections/GeoconnexFeatures/items'

export interface GeoconnexProperties {
  id: string
  feature_name: string | null
  feature_description: string | null
  geoconnex_sitemap: string | null
  mainstem_uri: string | null
}

export type GeoconnexFeature = Feature<Geometry, GeoconnexProperties>

function fmt(n: number): string {
  return Number(n.toFixed(7)).toString()
}

export function polygonWkt(ring: LngLat[]): string {
  return `POLYGON((${ring.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join(', ')}))`
}

/**
 * Features fully inside the cell. pygeoapi's CQL parser on this server uses the CQL1 name
 * WITHIN, not S_WITHIN. (INTERSECTS is deliberately not offered: many huge polygons
 * intersect most of the US, so it says little about a cell.)
 */
export function cellFilter(ring: LngLat[]): string {
  return `WITHIN(geometry, ${polygonWkt(ring)})`
}

export function itemsUrl(params: Record<string, string | number>, format = 'json'): string {
  const search = new URLSearchParams({ f: format })
  for (const [k, v] of Object.entries(params)) search.set(k, String(v))
  return `${ITEMS_URL}?${search}`
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, headers: { Accept: 'application/geo+json, application/json' } })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      detail = body.description ?? JSON.stringify(body)
    } catch {
      /* body was not JSON */
    }
    throw new Error(`Feature server returned ${res.status}: ${detail}`)
  }
  return res.json() as Promise<T>
}

export async function countFeatures(filter: string, signal?: AbortSignal): Promise<number | null> {
  const body = await getJson<{ numberMatched?: number }>(itemsUrl({ filter, resulttype: 'hits', limit: 1 }), signal)
  return body.numberMatched ?? null
}

export interface FeaturePage {
  features: GeoconnexFeature[]
  hasNext: boolean
}

export async function fetchFeatures(
  filter: string,
  { limit, offset }: { limit: number; offset: number },
  signal?: AbortSignal,
): Promise<FeaturePage> {
  const body = await getJson<FeatureCollection<Geometry, GeoconnexProperties> & { links?: { rel: string }[] }>(
    itemsUrl({ filter, limit, offset }),
    signal,
  )
  return {
    features: body.features,
    hasNext: body.links?.some((l) => l.rel === 'next') ?? body.features.length === limit,
  }
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/** Look up a feature by its Geoconnex IRI, trying the other http/https scheme if needed. */
export async function fetchFeatureByIri(iri: string, signal?: AbortSignal): Promise<GeoconnexFeature | null> {
  const candidates = [iri]
  if (iri.startsWith('https://')) candidates.push(iri.replace('https://', 'http://'))
  else if (iri.startsWith('http://')) candidates.push(iri.replace('http://', 'https://'))
  for (const candidate of candidates) {
    const page = await fetchFeatures(`id=${quote(candidate)}`, { limit: 1, offset: 0 }, signal)
    if (page.features.length > 0) return page.features[0]
  }
  return null
}
