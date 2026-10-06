import * as h3 from 'h3-js'
import { r1, s1, s2 } from 's2js'
import { boundsAreaKm2, densifyGreatCircleRing, EARTH_RADIUS_KM, type Bounds, type LngLat } from './geo'
import * as geohash from './geohash'

export type GridKind = 's2' | 'h3' | 'geohash'

export const GRID_KINDS: GridKind[] = ['s2', 'h3', 'geohash']

export const GRID_META: Record<
  GridKind,
  { label: string; levelName: string; shortLevel: string; min: number; max: number; color: string }
> = {
  s2: { label: 'S2', levelName: 'Level', shortLevel: 'lev', min: 0, max: 30, color: '#2563eb' },
  h3: { label: 'H3', levelName: 'Resolution', shortLevel: 'res', min: 0, max: 15, color: '#e8590c' },
  geohash: { label: 'Geohash', levelName: 'Precision', shortLevel: 'prec', min: 1, max: 12, color: '#9c36b5' },
}

export interface GridCell {
  kind: GridKind
  /** S2 token, H3 index, or geohash string */
  id: string
  level: number
  /** Closed ring, [lng, lat] (S2/H3 densified along great circles) */
  ring: LngLat[]
}

const D2R = Math.PI / 180
const R2D = 180 / Math.PI

export function avgCellAreaKm2(kind: GridKind, level: number): number {
  if (kind === 'h3') return h3.getHexagonAreaAvg(level, 'km2')
  if (kind === 'geohash') return (4 * Math.PI * EARTH_RADIUS_KM ** 2) / 32 ** level
  return (4 * Math.PI * EARTH_RADIUS_KM ** 2) / (6 * 4 ** level)
}

export function avgEdgeKm(kind: GridKind, level: number): number {
  if (kind === 'h3') return h3.getHexagonEdgeLengthAvg(level, 'km')
  return Math.sqrt(avgCellAreaKm2(kind, level))
}

/** Number of interpolated segments per cell edge so coarse cells follow their true geodesic edges. */
function segmentsPerEdge(kind: GridKind, level: number): number {
  const edgeKm = avgEdgeKm(kind, level)
  return Math.min(32, Math.max(1, Math.ceil(edgeKm / 50)))
}

export function cellFromId(kind: GridKind, id: string): GridCell {
  if (kind === 's2') {
    const cid = s2.cellid.fromToken(id)
    const cell = s2.Cell.fromCellID(cid)
    const ring: LngLat[] = [0, 1, 2, 3].map((k) => {
      const ll = s2.LatLng.fromPoint(cell.vertex(k))
      return [ll.lng * R2D, ll.lat * R2D]
    })
    const level = s2.cellid.level(cid)
    return { kind, id, level, ring: densifyGreatCircleRing(ring, segmentsPerEdge(kind, level)) }
  }
  if (kind === 'geohash') {
    // Geohash cells are lng/lat rectangles: straight edges in the same planar sense the
    // feature server uses, so no great-circle densification.
    const b = geohash.decodeBounds(id)
    const ring: LngLat[] = [
      [b.west, b.south],
      [b.east, b.south],
      [b.east, b.north],
      [b.west, b.north],
      [b.west, b.south],
    ]
    return { kind, id, level: id.length, ring }
  }
  const level = h3.getResolution(id)
  const ring = h3.cellToBoundary(id, true) as LngLat[]
  return { kind, id, level, ring: densifyGreatCircleRing(ring, segmentsPerEdge(kind, level)) }
}

export function s2CellIdToToken(cid: bigint): string {
  return s2.cellid.toToken(cid)
}

export function cellIdAt(kind: GridKind, lng: number, lat: number, level: number): string {
  if (kind === 's2') {
    const leaf = s2.cellid.fromLatLng(s2.LatLng.fromDegrees(lat, lng))
    return s2.cellid.toToken(s2.cellid.parent(leaf, level))
  }
  if (kind === 'geohash') return geohash.encode(lat, wrapLng(lng), level)
  return h3.latLngToCell(lat, lng, level)
}

export function cellAt(kind: GridKind, lng: number, lat: number, level: number): GridCell {
  return cellFromId(kind, cellIdAt(kind, lng, lat, level))
}

export interface ViewportCells {
  cells: GridCell[]
  estimate: number
  tooMany: boolean
}

function wrapLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180
}

function normalizeBounds(b: Bounds): Bounds {
  const south = Math.max(-85, b.south)
  const north = Math.min(85, b.north)
  if (b.east - b.west >= 360) return { west: -180, east: 180, south, north }
  const shift = Math.floor((b.west + 180) / 360) * 360
  return { west: b.west - shift, east: b.east - shift, south, north }
}

/** Split a normalized bbox into rings no wider than 90° that stay within [-180, 180]. */
function boundsToRings(b: Bounds): LngLat[][] {
  const rings: LngLat[][] = []
  const pieces: [number, number][] = b.east > 180 ? [[b.west, 180], [-180, b.east - 360]] : [[b.west, b.east]]
  for (const [w, e] of pieces) {
    for (let x = w; x < e; x += 90) {
      const xe = Math.min(e, x + 90)
      rings.push([
        [x, b.south],
        [xe, b.south],
        [xe, b.north],
        [x, b.north],
        [x, b.south],
      ])
    }
  }
  return rings
}

export function viewportCells(kind: GridKind, bounds: Bounds, level: number, limit: number): ViewportCells {
  const b = normalizeBounds(bounds)
  const estimate = Math.ceil(boundsAreaKm2(b) / avgCellAreaKm2(kind, level))
  if (estimate > limit) return { cells: [], estimate, tooMany: true }

  let ids: string[]
  if (kind === 's2') {
    const lng = b.east - b.west >= 360 ? s1.Interval.fullInterval() : new s1.Interval(b.west * D2R, (b.east > 180 ? b.east - 360 : b.east) * D2R)
    const rect = new s2.Rect(new r1.Interval(b.south * D2R, b.north * D2R), lng)
    const coverer = new s2.RegionCoverer({ minLevel: level, maxLevel: level, maxCells: limit * 2 })
    ids = coverer.covering(rect).map((c) => s2.cellid.toToken(c))
  } else if (kind === 'geohash') {
    const { width, height } = geohash.cellSizeDeg(level)
    const set = new Set<string>()
    const lngEnd = b.east - b.west >= 360 ? b.west + 360 : b.east
    for (let lat = Math.floor(b.south / height) * height; lat < b.north; lat += height) {
      for (let lng = Math.floor(b.west / width) * width; lng < lngEnd; lng += width) {
        set.add(geohash.encode(lat + height / 2, wrapLng(lng + width / 2), level))
      }
    }
    ids = [...set]
  } else {
    const set = new Set<string>()
    for (const ring of boundsToRings(b)) {
      for (const c of h3.polygonToCellsExperimental([ring], level, h3.POLYGON_TO_CELLS_FLAGS.containmentOverlapping, true)) set.add(c)
    }
    ids = [...set]
  }
  if (ids.length > limit * 1.5) return { cells: [], estimate: ids.length, tooMany: true }
  return { cells: ids.map((id) => cellFromId(kind, id)), estimate, tooMany: false }
}

export function cellAreaKm2(cell: GridCell): number {
  if (cell.kind === 'h3') return h3.cellArea(cell.id, 'km2')
  if (cell.kind === 'geohash') return boundsAreaKm2(geohash.decodeBounds(cell.id))
  const area = s2.Cell.fromCellID(s2.cellid.fromToken(cell.id)).exactArea()
  return area * EARTH_RADIUS_KM ** 2
}
