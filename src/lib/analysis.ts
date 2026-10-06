import type { Geometry, Position } from 'geojson'
import * as h3 from 'h3-js'
import { geojson as s2geojson, s2 } from 's2js'
import {
  densifyPlanar,
  EARTH_RADIUS_KM,
  geometryBounds,
  geometryParts,
  geometryVertices,
  lineLengthKm,
  polygonAreaKm2,
  type Bounds,
  type LngLat,
} from './geo'
import * as geohash from './geohash'
import { avgEdgeKm, cellAreaKm2, cellFromId, GRID_META, type GridCell, type GridKind } from './grids'

/** Max cells drawn on the map for a covering. */
const DISPLAY_LIMIT = 3000
/** Max cells the S2 coverer may emit before the count becomes an upper bound. */
const S2_COVER_CAP = 20000
/** Above this estimated count, H3 cells are estimated instead of enumerated. */
const H3_ENUMERATE_LIMIT = 2_000_000
/** Max boundary cells the geohash polygon recursion resolves exactly (it is cheaper than the S2 coverer). */
const GEOHASH_BOUNDARY_CAP = 100_000
/** Max sample points when walking lines; beyond this the line share is estimated. */
const LINE_WALK_LIMIT = 8_000_000
/** Mean chord through a square cell (Cauchy: πA/P = π/4 × side). */
const S2_MEAN_CHORD = Math.PI / 4
/** Planar densification (degrees) so geodesic and planar edge interpretations agree. */
const DENSIFY_DEG = 0.02

export interface CellCount {
  level: number
  /** Number of level-N cells that intersect the geometry (bigint: S2 level 30 counts exceed 2^53). */
  count: bigint
  quality: 'exact' | 'upperBound' | 'estimate'
  note?: string
}

export interface GridAnalysis {
  kind: GridKind
  /** The finest single cell that fully contains the geometry. */
  smallest: GridCell | null
  smallestNote?: string
  /** H3 only: every resolution at which a single cell contains the geometry (not always contiguous). */
  fitsAt?: number[]
  count: CellCount
  /** Cells to draw for the covering, in both styles so the UI can switch without recomputing. */
  display: CoveringDisplay
  ms: number
}

export interface CoveringDisplay {
  /** Normalized/compacted covering: interior cells merged into coarser parents. */
  mixed: GridCell[]
  mixedNote?: string
  /** Every intersecting cell at exactly level N. */
  uniform: GridCell[]
  uniformNote?: string
}

const tooManyMixed = (n: number) => `The mixed-level covering has ${n.toLocaleString()} cells — too many to draw.`
const tooManyUniform = (n: bigint | number, kind: GridKind, level: number, hint = true) =>
  `${n.toLocaleString()} ${GRID_META[kind].levelName.toLowerCase()}-${level} cells — too many to draw at a single level (limit ${DISPLAY_LIMIT.toLocaleString()}).` +
  (hint ? ' Turn on mixed levels to see a merged covering.' : '')

export function analyze(geometry: Geometry, kind: GridKind, level: number): GridAnalysis {
  const start = performance.now()
  const dense = densifyPlanar(geometry, DENSIFY_DEG)
  const result = kind === 's2' ? analyzeS2(dense, level) : kind === 'h3' ? analyzeH3(dense, level) : analyzeGeohash(dense, level)
  return { ...result, kind, ms: performance.now() - start }
}

type PartialAnalysis = Omit<GridAnalysis, 'kind' | 'ms'>

function geometryCenter(geometry: Geometry): LngLat {
  const b = geometryBounds(geometry)!
  return [(b.west + b.east) / 2, (b.south + b.north) / 2]
}

/* ------------------------------------------------------------------ S2 */

function s2SmallestCell(vertices: Position[]): { cell: GridCell | null; note?: string } {
  if (vertices.length === 0) return { cell: null, note: 'Geometry has no vertices' }
  // S2 cells are convex on the sphere, so a cell containing every vertex contains the
  // whole (densified) geometry. The smallest such cell is the common ancestor of the
  // leaf cells of all vertices.
  let ancestor = s2.cellid.fromLatLng(s2.LatLng.fromDegrees(vertices[0][1], vertices[0][0]))
  for (let i = 1; i < vertices.length; i++) {
    const leaf = s2.cellid.fromLatLng(s2.LatLng.fromDegrees(vertices[i][1], vertices[i][0]))
    if (s2.cellid.contains(ancestor, leaf)) continue
    const [lvl, ok] = s2.cellid.commonAncestorLevel(ancestor, leaf)
    if (!ok) return { cell: null, note: 'Spans more than one S2 cube face, so no single cell (even level 0) contains it' }
    ancestor = s2.cellid.parent(ancestor, lvl)
  }
  return { cell: cellFromId('s2', s2.cellid.toToken(ancestor)) }
}

function expandS2(cid: bigint, level: number): bigint[] {
  if (s2.cellid.level(cid) === level) return [cid]
  const out: bigint[] = []
  const end = s2.cellid.childEndAtLevel(cid, level)
  for (let c = s2.cellid.childBeginAtLevel(cid, level); c !== end; c = s2.cellid.next(c)) out.push(c)
  return out
}

/** Sort cells along the Hilbert curve and drop any cell contained in an earlier (coarser) one. */
function dedupeS2(ids: bigint[]): bigint[] {
  const sorted = ids
    .map((id) => ({ id, min: s2.cellid.rangeMin(id), level: s2.cellid.level(id) }))
    .sort((a, b) => (a.min < b.min ? -1 : a.min > b.min ? 1 : a.level - b.level))
  const out: bigint[] = []
  for (const { id } of sorted) {
    const last = out[out.length - 1]
    if (last === undefined || !s2.cellid.contains(last, id)) out.push(id)
  }
  return out
}

/** Collect the cell of every point visited when walking each line in sub-cell steps. */
function walkLines(lines: Position[][], stepDeg: number, cellOf: (lng: number, lat: number) => void) {
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      const [x1, y1] = line[i]
      cellOf(x1, y1)
      if (i === 0) continue
      const [x0, y0] = line[i - 1]
      const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / stepDeg)
      for (let s = 1; s < n; s++) cellOf(x0 + ((x1 - x0) * s) / n, y0 + ((y1 - y0) * s) / n)
    }
  }
}

function analyzeS2(geometry: Geometry, level: number): PartialAnalysis {
  const { cell: smallest, note: smallestNote } = s2SmallestCell(geometryVertices(geometry))
  const parts = geometryParts(geometry)
  const edgeKm = avgEdgeKm('s2', level)
  const lineKm = parts.lines.reduce((a, l) => a + lineLengthKm(l), 0)
  const leafAt = (lng: number, lat: number) => s2.cellid.parent(s2.cellid.fromLatLng(s2.LatLng.fromDegrees(lat, lng)), level)

  const ids: bigint[] = []
  let quality: CellCount['quality'] = 'exact'
  const notes: string[] = []

  // Polygons: a covering with levels <= N. Cells coarser than N lie fully inside the
  // polygon, so each one stands for 4^(N - level) level-N cells. Parts are covered one
  // at a time because s2js's multi-member GeoJSON coverer overflows the stack on large unions.
  const areaKm2 = parts.polygons.reduce((a, p) => a + polygonAreaKm2(p), 0)
  const perimeterKm = parts.polygons.reduce((a, p) => a + p.reduce((b, r) => b + lineLengthKm(r), 0), 0)
  const boundaryCells = perimeterKm / (S2_MEAN_CHORD * edgeKm)
  const displayOnly: bigint[] = []
  let polygonEstimate = 0
  if (parts.polygons.length > 0 && boundaryCells > S2_COVER_CAP / 2) {
    // Resolving the whole boundary at level N would blow the budget; estimate instead and
    // draw a coarse covering for context.
    quality = 'estimate'
    const center = geometryCenter(geometry)
    const localKm2 = s2.Cell.fromCellID(leafAt(center[0], center[1])).exactArea() * EARTH_RADIUS_KM ** 2
    polygonEstimate = Math.round(areaKm2 / localKm2 + boundaryCells / 2)
    notes.push(
      `The boundary alone needs ~${Math.round(boundaryCells).toLocaleString()} level-${level} cells, beyond the in-browser budget. Estimated as area ÷ local cell area + ½ × boundary cells.`,
    )
    const coarse = new s2geojson.RegionCoverer({ minLevel: 0, maxLevel: level, maxCells: 500 })
    for (const polygon of parts.polygons) for (const c of coarse.covering({ type: 'Polygon', coordinates: polygon })) displayOnly.push(c)
  } else {
    const coverer = new s2geojson.RegionCoverer({ minLevel: 0, maxLevel: level, maxCells: S2_COVER_CAP })
    for (const polygon of parts.polygons) {
      const cov = coverer.covering({ type: 'Polygon', coordinates: polygon })
      if (cov.length >= S2_COVER_CAP * 0.9) quality = 'upperBound'
      for (const c of cov) ids.push(c)
    }
    if (quality === 'upperBound') {
      notes.push(
        `The coverer hit its ${S2_COVER_CAP.toLocaleString()}-cell budget before resolving the whole boundary to level ${level}, so this is an upper bound.`,
      )
    }
  }

  for (const [lng, lat] of parts.points) ids.push(leafAt(lng, lat))

  let lineEstimate = 0
  if (lineKm / (edgeKm / 4) > LINE_WALK_LIMIT) {
    lineEstimate = Math.round(lineKm / (S2_MEAN_CHORD * edgeKm))
    quality = 'estimate'
    notes.push('Lines are too long to walk at this level; their share is estimated as length ÷ mean cell chord.')
  } else {
    walkLines(parts.lines, Math.max(1e-10, edgeKm / 4 / 111.32), (lng, lat) => ids.push(leafAt(lng, lat)))
  }

  const counted = dedupeS2(ids)
  let count = BigInt(lineEstimate + polygonEstimate)
  for (const c of counted) count += 4n ** BigInt(level - s2.cellid.level(c))
  const covering = displayOnly.length ? dedupeS2([...ids, ...displayOnly]) : counted

  const toCell = (c: bigint) => cellFromId('s2', s2.cellid.toToken(c))
  const uniformOk = quality === 'exact' && count <= BigInt(DISPLAY_LIMIT)
  const display: CoveringDisplay = {
    mixed: covering.length <= DISPLAY_LIMIT ? covering.map(toCell) : [],
    mixedNote: covering.length <= DISPLAY_LIMIT ? undefined : tooManyMixed(covering.length),
    uniform: uniformOk ? covering.flatMap((c) => expandS2(c, level)).map(toCell) : [],
    uniformNote: uniformOk ? undefined : tooManyUniform(count, 's2', level, covering.length <= DISPLAY_LIMIT),
  }

  return { smallest, smallestNote, count: { level, count, quality, note: notes.join(' ') || undefined }, display }
}

/* ------------------------------------------------------------------ H3 */

function h3SmallestCell(vertices: Position[]): { cell: GridCell | null; note?: string; fitsAt: number[] } {
  if (vertices.length === 0) return { cell: null, note: 'Geometry has no vertices', fitsAt: [] }
  // H3 cells are not nested (a child can stick out of its parent), so a geometry can fit
  // in one cell at resolution r+1 but not at r. Test every resolution independently: it
  // fits at r if every vertex falls in the same cell (cells are convex in the gnomonic
  // face projection, so edges between vertices stay inside).
  let best: string | null = null
  const fitsAt: number[] = []
  for (let res = 0; res <= 15; res++) {
    const first = h3.latLngToCell(vertices[0][1], vertices[0][0], res)
    let same = true
    for (let i = 1; i < vertices.length && same; i++) {
      same = h3.latLngToCell(vertices[i][1], vertices[i][0], res) === first
    }
    if (same) {
      best = first
      fitsAt.push(res)
    }
  }
  if (!best) return { cell: null, note: 'No single H3 cell at any resolution contains it', fitsAt }
  return { cell: cellFromId('h3', best), fitsAt }
}

function analyzeH3(geometry: Geometry, level: number): PartialAnalysis {
  const { cell: smallest, note: smallestNote, fitsAt } = h3SmallestCell(geometryVertices(geometry))
  const parts = geometryParts(geometry)
  const edgeKm = avgEdgeKm('h3', level)
  const center = geometryCenter(geometry)
  const cellKm2 = h3.cellArea(h3.latLngToCell(center[1], center[0], level), 'km2')
  // Mean chord through a hexagon (Cauchy: πA/P) ≈ 2.72 × edge length.
  const meanChordKm = 2.72 * edgeKm

  const lineKm = parts.lines.reduce((a, l) => a + lineLengthKm(l), 0)
  const polyKm2 = parts.polygons.reduce((a, p) => a + polygonAreaKm2(p), 0)
  const perimeterKm = parts.polygons.reduce((a, p) => a + p.reduce((b, r) => b + lineLengthKm(r), 0), 0)
  const estimate = parts.points.length + lineKm / meanChordKm + polyKm2 / cellKm2 + perimeterKm / meanChordKm / 2

  // Walking lines costs ~4 latLngToCell calls per edge length, so guard that too.
  const lineSteps = lineKm / (edgeKm / 4)
  if (estimate > H3_ENUMERATE_LIMIT || lineSteps > LINE_WALK_LIMIT) {
    return {
      smallest,
      smallestNote,
      fitsAt,
      count: {
        level,
        count: BigInt(Math.round(estimate)),
        quality: 'estimate',
        note: `Too many cells to enumerate in the browser; estimated as area ÷ local cell area + ½ × (perimeter ÷ mean hexagon chord) + line length ÷ mean hexagon chord.`,
      },
      display: {
        mixed: [],
        mixedNote: 'Too many cells to enumerate, so there is no covering to draw.',
        uniform: [],
        uniformNote: tooManyUniform(BigInt(Math.round(estimate)), 'h3', level, false),
      },
    }
  }

  const cells = new Set<string>()
  for (const [lng, lat] of parts.points) cells.add(h3.latLngToCell(lat, lng, level))
  // Walk lines in steps much shorter than a cell so no crossed cell is skipped.
  walkLines(parts.lines, Math.max(1e-10, edgeKm / 4 / 111.32), (lng, lat) => cells.add(h3.latLngToCell(lat, lng, level)))
  for (const polygon of parts.polygons) {
    for (const c of h3.polygonToCellsExperimental(polygon, level, h3.POLYGON_TO_CELLS_FLAGS.containmentOverlapping, true)) {
      cells.add(c)
    }
  }

  const compacted = h3.compactCells([...cells])
  const display: CoveringDisplay = {
    mixed: compacted.length <= DISPLAY_LIMIT ? compacted.map((id) => cellFromId('h3', id)) : [],
    mixedNote: compacted.length <= DISPLAY_LIMIT ? undefined : tooManyMixed(compacted.length),
    uniform: cells.size <= DISPLAY_LIMIT ? [...cells].map((id) => cellFromId('h3', id)) : [],
    uniformNote: cells.size <= DISPLAY_LIMIT ? undefined : tooManyUniform(cells.size, 'h3', level, compacted.length <= DISPLAY_LIMIT),
  }

  return {
    smallest,
    smallestNote,
    fitsAt,
    count: { level, count: BigInt(cells.size), quality: 'exact' },
    display,
  }
}

/* ------------------------------------------------------------- Geohash */

/** Geohash cells nest by prefix, so the smallest containing cell is the vertices' common prefix. */
function geohashSmallestCell(vertices: Position[]): { cell: GridCell | null; note?: string } {
  if (vertices.length === 0) return { cell: null, note: 'Geometry has no vertices' }
  // Cells are lng/lat rectangles, so a cell holding every vertex holds every planar edge too.
  let prefix = geohash.encode(vertices[0][1], vertices[0][0], 12)
  for (let i = 1; i < vertices.length && prefix.length > 0; i++) {
    const h = geohash.encode(vertices[i][1], vertices[i][0], prefix.length)
    let n = 0
    while (n < prefix.length && prefix[n] === h[n]) n++
    prefix = prefix.slice(0, n)
  }
  if (!prefix) return { cell: null, note: 'Spans more than one precision-1 cell, so no single geohash contains it' }
  return { cell: cellFromId('geohash', prefix) }
}

type Segment = [number, number, number, number]

function segmentHitsRect([x0, y0, x1, y1]: Segment, b: Bounds): boolean {
  // Liang–Barsky clip: does any part of the segment lie inside the closed rectangle?
  let t0 = 0
  let t1 = 1
  const dx = x1 - x0
  const dy = y1 - y0
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0
    const t = q / p
    if (p < 0) {
      if (t > t1) return false
      if (t > t0) t0 = t
    } else {
      if (t < t0) return false
      if (t < t1) t1 = t
    }
    return true
  }
  return clip(-dx, x0 - b.west) && clip(dx, b.east - x0) && clip(-dy, y0 - b.south) && clip(dy, b.north - y0)
}

function pointInRings(x: number, y: number, rings: Position[][]): boolean {
  // Even-odd rule over all rings handles holes.
  let inside = false
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]
      const [xj, yj] = ring[j]
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
  }
  return inside
}

interface GeohashCover {
  /** Cells (precision <= N) entirely inside the polygon */
  inside: string[]
  /** Precision-N cells the boundary passes through */
  boundary: string[]
}

/**
 * Recursively subdivide geohash cells: cells the boundary doesn't touch are entirely
 * inside or outside; the rest split into 32 children down to precision N. Each cell
 * only tests the edges that touched its parent, so the work tracks the boundary length.
 */
function coverPolygonGeohash(rings: Position[][], precision: number): GeohashCover {
  const segments: Segment[] = rings.flatMap((ring) =>
    ring.slice(1).map((p, i) => [ring[i][0], ring[i][1], p[0], p[1]] as Segment),
  )
  const out: GeohashCover = { inside: [], boundary: [] }
  const visit = (hash: string, segs: Segment[]) => {
    const b = geohash.decodeBounds(hash)
    const hits = segs.filter((s) => segmentHitsRect(s, b))
    if (hits.length === 0) {
      if (pointInRings((b.west + b.east) / 2, (b.south + b.north) / 2, rings)) out.inside.push(hash)
      return
    }
    if (hash.length === precision) {
      out.boundary.push(hash)
      return
    }
    for (const child of geohash.children(hash)) visit(child, hits)
  }
  for (const c of geohash.GEOHASH_CHARS) visit(c, segments)
  return out
}

/** Sort and drop cells whose prefix is already present. */
function dedupeGeohash(hashes: string[]): string[] {
  const out: string[] = []
  for (const h of [...new Set(hashes)].sort()) {
    const last = out[out.length - 1]
    if (last === undefined || !h.startsWith(last)) out.push(h)
  }
  return out
}

function analyzeGeohash(geometry: Geometry, level: number): PartialAnalysis {
  const { cell: smallest, note: smallestNote } = geohashSmallestCell(geometryVertices(geometry))
  const parts = geometryParts(geometry)
  const { width, height } = geohash.cellSizeDeg(level)
  const center = geometryCenter(geometry)
  const cellKm2 = cellAreaKm2(cellFromId('geohash', geohash.encode(center[1], center[0], level)))
  // Cell size in km at this latitude, for the mean-chord estimate (Cauchy: πA/P).
  const wKm = width * 111.32 * Math.cos((center[1] * Math.PI) / 180)
  const hKm = height * 110.57
  const meanChordKm = (Math.PI * wKm * hKm) / (2 * (wKm + hKm))

  const hashes: string[] = []
  let quality: CellCount['quality'] = 'exact'
  const notes: string[] = []
  let estimate = 0
  const displayOnly: string[] = []

  for (const [lng, lat] of parts.points) hashes.push(geohash.encode(lat, lng, level))

  const lineKm = parts.lines.reduce((a, l) => a + lineLengthKm(l), 0)
  const stepDeg = Math.min(width, height) / 4
  const lineDeg = parts.lines.reduce((a, l) => a + l.slice(1).reduce((b, p, i) => b + Math.hypot(p[0] - l[i][0], p[1] - l[i][1]), 0), 0)
  if (lineDeg / stepDeg > LINE_WALK_LIMIT) {
    quality = 'estimate'
    estimate += lineKm / meanChordKm
    notes.push('Lines are too long to walk at this precision; their share is estimated as length ÷ mean cell chord.')
  } else {
    walkLines(parts.lines, stepDeg, (lng, lat) => hashes.push(geohash.encode(lat, lng, level)))
  }

  const perimeterKm = parts.polygons.reduce((a, p) => a + p.reduce((b, r) => b + lineLengthKm(r), 0), 0)
  const boundaryCells = perimeterKm / meanChordKm
  if (parts.polygons.length > 0 && boundaryCells > GEOHASH_BOUNDARY_CAP) {
    quality = 'estimate'
    const areaKm2 = parts.polygons.reduce((a, p) => a + polygonAreaKm2(p), 0)
    estimate += areaKm2 / cellKm2 + boundaryCells / 2
    notes.push(
      `The boundary alone needs ~${Math.round(boundaryCells).toLocaleString()} precision-${level} cells, beyond the in-browser budget. Estimated as area ÷ local cell area + ½ × boundary cells.`,
    )
    // Coarse covering for the map: the finest precision whose boundary fits ~1,000 cells.
    let p = level
    while (p > 1 && boundaryCells / Math.sqrt(32) ** (level - p) > 1000) p--
    for (const polygon of parts.polygons) {
      const cover = coverPolygonGeohash(polygon, p)
      // Loop rather than push(...xs): spreading ~1e5 arguments overflows a worker's stack.
      for (const h of cover.inside) displayOnly.push(h)
      for (const h of cover.boundary) displayOnly.push(h)
    }
  } else {
    for (const polygon of parts.polygons) {
      const cover = coverPolygonGeohash(polygon, level)
      for (const h of cover.inside) hashes.push(h)
      for (const h of cover.boundary) hashes.push(h)
    }
  }

  const counted = dedupeGeohash(hashes)
  let count = BigInt(Math.round(estimate))
  for (const h of counted) count += 32n ** BigInt(level - h.length)
  const covering = displayOnly.length ? dedupeGeohash([...hashes, ...displayOnly]) : counted

  const toCell = (h: string) => cellFromId('geohash', h)
  const expand = (h: string): string[] => (h.length >= level ? [h] : geohash.children(h).flatMap(expand))
  const uniformOk = quality === 'exact' && count <= BigInt(DISPLAY_LIMIT)
  const display: CoveringDisplay = {
    mixed: covering.length <= DISPLAY_LIMIT ? covering.map(toCell) : [],
    mixedNote: covering.length <= DISPLAY_LIMIT ? undefined : tooManyMixed(covering.length),
    uniform: uniformOk ? covering.flatMap(expand).map(toCell) : [],
    uniformNote: uniformOk ? undefined : tooManyUniform(count, 'geohash', level, covering.length <= DISPLAY_LIMIT),
  }

  return { smallest, smallestNote, count: { level, count, quality, note: notes.join(' ') || undefined }, display }
}
