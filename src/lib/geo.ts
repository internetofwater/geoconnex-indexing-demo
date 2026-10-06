import type { Geometry, Position } from 'geojson'

/** [lng, lat] in degrees */
export type LngLat = [number, number]

export interface Bounds {
  west: number
  south: number
  east: number
  north: number
}

export const EARTH_RADIUS_KM = 6371.0088
const D2R = Math.PI / 180
const R2D = 180 / Math.PI

type Vec3 = [number, number, number]

function toVec([lng, lat]: LngLat): Vec3 {
  const phi = lat * D2R
  const lambda = lng * D2R
  return [Math.cos(phi) * Math.cos(lambda), Math.cos(phi) * Math.sin(lambda), Math.sin(phi)]
}

function fromVec([x, y, z]: Vec3): LngLat {
  return [Math.atan2(y, x) * R2D, Math.atan2(z, Math.hypot(x, y)) * R2D]
}

/**
 * Densify a closed ring along great circles. S2 and H3 cell edges are geodesics,
 * while PostGIS (and the map) draw straight lines in lng/lat, so coarse cells need
 * extra vertices to look and query correctly.
 */
export function densifyGreatCircleRing(ring: LngLat[], segmentsPerEdge: number): LngLat[] {
  if (segmentsPerEdge <= 1) return closeRing(ring)
  const closed = closeRing(ring)
  const out: LngLat[] = []
  for (let i = 0; i < closed.length - 1; i++) {
    const a = toVec(closed[i])
    const b = toVec(closed[i + 1])
    for (let s = 0; s < segmentsPerEdge; s++) {
      const t = s / segmentsPerEdge
      const v: Vec3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
      out.push(fromVec(v))
    }
  }
  out.push(out[0])
  return unwrapRing(out)
}

export function closeRing(ring: LngLat[]): LngLat[] {
  const first = ring[0]
  const last = ring[ring.length - 1]
  if (first[0] === last[0] && first[1] === last[1]) return ring
  return [...ring, first]
}

/** Make longitudes continuous so rings crossing the antimeridian don't smear across the map. */
export function unwrapRing(ring: LngLat[]): LngLat[] {
  const out: LngLat[] = [ring[0]]
  for (let i = 1; i < ring.length; i++) {
    let lng = ring[i][0]
    const prev = out[i - 1][0]
    while (lng - prev > 180) lng -= 360
    while (lng - prev < -180) lng += 360
    out.push([lng, ring[i][1]])
  }
  return out
}

function densifyLine(coords: Position[], maxSegDeg: number): Position[] {
  if (coords.length < 2) return coords
  const out: Position[] = [coords[0]]
  for (let i = 1; i < coords.length; i++) {
    const [x0, y0] = coords[i - 1]
    const [x1, y1] = coords[i]
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / maxSegDeg)
    for (let s = 1; s < n; s++) out.push([x0 + ((x1 - x0) * s) / n, y0 + ((y1 - y0) * s) / n])
    out.push(coords[i])
  }
  return out
}

/**
 * Add vertices along long straight (planar lng/lat) segments. The feature server
 * stores geometries in EPSG:4326 and treats edges as planar; S2/H3 treat them as
 * geodesics. Densifying makes both interpretations agree.
 */
export function densifyPlanar(geom: Geometry, maxSegDeg: number): Geometry {
  switch (geom.type) {
    case 'Point':
    case 'MultiPoint':
      return geom
    case 'LineString':
      return { type: 'LineString', coordinates: densifyLine(geom.coordinates, maxSegDeg) }
    case 'MultiLineString':
      return { type: 'MultiLineString', coordinates: geom.coordinates.map((l) => densifyLine(l, maxSegDeg)) }
    case 'Polygon':
      return { type: 'Polygon', coordinates: geom.coordinates.map((r) => densifyLine(r, maxSegDeg)) }
    case 'MultiPolygon':
      return {
        type: 'MultiPolygon',
        coordinates: geom.coordinates.map((p) => p.map((r) => densifyLine(r, maxSegDeg))),
      }
    case 'GeometryCollection':
      return { type: 'GeometryCollection', geometries: geom.geometries.map((g) => densifyPlanar(g, maxSegDeg)) }
  }
}

export function geometryVertices(geom: Geometry): Position[] {
  switch (geom.type) {
    case 'Point':
      return [geom.coordinates]
    case 'MultiPoint':
    case 'LineString':
      return geom.coordinates
    case 'MultiLineString':
    case 'Polygon':
      return geom.coordinates.flat()
    case 'MultiPolygon':
      return geom.coordinates.flat(2)
    case 'GeometryCollection':
      return geom.geometries.flatMap(geometryVertices)
  }
}

export function geometryBounds(geom: Geometry): Bounds | null {
  const verts = geometryVertices(geom)
  if (verts.length === 0) return null
  const b = { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity }
  for (const [x, y] of verts) {
    if (x < b.west) b.west = x
    if (x > b.east) b.east = x
    if (y < b.south) b.south = y
    if (y > b.north) b.north = y
  }
  return b
}

function haversineKm(a: Position, b: Position): number {
  const dLat = (b[1] - a[1]) * D2R
  const dLng = (b[0] - a[0]) * D2R
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * D2R) * Math.cos(b[1] * D2R) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function lineLengthKm(coords: Position[]): number {
  let total = 0
  for (let i = 1; i < coords.length; i++) total += haversineKm(coords[i - 1], coords[i])
  return total
}

/** Spherical ring area (km²), same formula as mapbox/geojson-area. */
export function ringAreaKm2(ring: Position[]): number {
  let area = 0
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[i + 1]
    area += (x2 - x1) * D2R * (2 + Math.sin(y1 * D2R) + Math.sin(y2 * D2R))
  }
  return Math.abs((area * EARTH_RADIUS_KM * EARTH_RADIUS_KM) / 2)
}

export function polygonAreaKm2(rings: Position[][]): number {
  if (rings.length === 0) return 0
  return Math.max(0, ringAreaKm2(rings[0]) - rings.slice(1).reduce((a, r) => a + ringAreaKm2(r), 0))
}

export interface GeometryParts {
  points: Position[]
  lines: Position[][]
  polygons: Position[][][]
}

export function geometryParts(geom: Geometry, parts: GeometryParts = { points: [], lines: [], polygons: [] }): GeometryParts {
  switch (geom.type) {
    case 'Point':
      parts.points.push(geom.coordinates)
      break
    case 'MultiPoint':
      parts.points.push(...geom.coordinates)
      break
    case 'LineString':
      parts.lines.push(geom.coordinates)
      break
    case 'MultiLineString':
      parts.lines.push(...geom.coordinates)
      break
    case 'Polygon':
      parts.polygons.push(geom.coordinates)
      break
    case 'MultiPolygon':
      parts.polygons.push(...geom.coordinates)
      break
    case 'GeometryCollection':
      geom.geometries.forEach((g) => geometryParts(g, parts))
      break
  }
  return parts
}

export interface GeometrySummary {
  type: string
  vertices: number
  areaKm2: number
  lengthKm: number
}

export function summarizeGeometry(geom: Geometry): GeometrySummary {
  const parts = geometryParts(geom)
  return {
    type: geom.type,
    vertices: geometryVertices(geom).length,
    areaKm2: parts.polygons.reduce((a, p) => a + polygonAreaKm2(p), 0),
    lengthKm: parts.lines.reduce((a, l) => a + lineLengthKm(l), 0),
  }
}

/** Approximate spherical area of a lng/lat rectangle in km². */
export function boundsAreaKm2(b: Bounds): number {
  const dLng = Math.min(360, b.east - b.west) * D2R
  return EARTH_RADIUS_KM ** 2 * dLng * Math.abs(Math.sin(b.north * D2R) - Math.sin(b.south * D2R))
}

export function formatArea(km2: number): string {
  if (km2 >= 1) return `${km2.toLocaleString(undefined, { maximumFractionDigits: km2 >= 100 ? 0 : 2 })} km²`
  const m2 = km2 * 1e6
  if (m2 >= 1) return `${m2.toLocaleString(undefined, { maximumFractionDigits: m2 >= 100 ? 0 : 2 })} m²`
  return `${(m2 * 1e4).toLocaleString(undefined, { maximumFractionDigits: 2 })} cm²`
}

export function formatLength(km: number): string {
  if (km >= 1) return `${km.toLocaleString(undefined, { maximumFractionDigits: km >= 100 ? 0 : 2 })} km`
  const m = km * 1000
  if (m >= 1) return `${m.toLocaleString(undefined, { maximumFractionDigits: 2 })} m`
  return `${(m * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })} cm`
}
