import type { Polygon } from 'geojson'
import * as h3 from 'h3-js'
import { geojson as s2geojson, s2 } from 's2js'
import { describe, expect, it } from 'vitest'
import { analyze } from '../analysis'
import { densifyPlanar } from '../geo'

const square = (x: number, y: number, d: number): Polygon => ({
  type: 'Polygon',
  coordinates: [
    [
      [x, y],
      [x + d, y],
      [x + d, y + d],
      [x, y + d],
      [x, y],
    ],
  ],
})

describe('analyze (S2)', () => {
  it('counts level-N cells exactly, matching a fixed-level covering', () => {
    const poly = square(-105.1, 39.6, 0.2)
    const fixed = new s2geojson.RegionCoverer({ minLevel: 13, maxLevel: 13, maxCells: 1e6 }).covering(
      densifyPlanar(poly, 0.02),
    )
    const result = analyze(poly, 's2', 13)
    expect(result.count.quality).toBe('exact')
    // the fixed-level covering is normalized, so expand it back to level 13
    const expected = fixed.reduce((a, c) => a + 4 ** (13 - s2.cellid.level(c)), 0)
    expect(Number(result.count.count)).toBe(expected)
  })

  it('finds the smallest single containing cell', () => {
    const result = analyze(square(-105.1, 39.6, 0.2), 's2', 13)
    const smallest = s2.cellid.fromToken(result.smallest!.id)
    for (const [lng, lat] of square(-105.1, 39.6, 0.2).coordinates[0]) {
      expect(s2.cellid.contains(smallest, s2.cellid.fromLatLng(s2.LatLng.fromDegrees(lat, lng)))).toBe(true)
    }
    // no child contains every vertex
    const children = s2.cellid.children(smallest)
    const vertices = square(-105.1, 39.6, 0.2).coordinates[0]
    for (const child of children) {
      const all = vertices.every(([lng, lat]) => s2.cellid.contains(child, s2.cellid.fromLatLng(s2.LatLng.fromDegrees(lat, lng))))
      expect(all).toBe(false)
    }
  })

  it('handles MultiPolygons without overflowing (s2js multi-member coverer regression)', () => {
    const multi = {
      type: 'MultiPolygon' as const,
      coordinates: [square(-105.1, 39.6, 0.5).coordinates, square(-104.4, 39.6, 0.5).coordinates],
    }
    const result = analyze(multi, 's2', 15)
    expect(result.count.count).toBeGreaterThan(0n)
  })

  it('treats a point as a single cell at any level', () => {
    const result = analyze({ type: 'Point', coordinates: [-95.17, 43.4] }, 's2', 20)
    expect(result.count.count).toBe(1n)
    expect(result.smallest!.level).toBe(30)
  })

  it('estimates instead of enumerating when the boundary is too large', () => {
    const result = analyze(square(-109, 37, 7), 's2', 22)
    expect(result.count.quality).toBe('estimate')
    expect(result.ms).toBeLessThan(5000)
  })
})

describe('analyze (H3)', () => {
  it('counts every cell overlapping a polygon', () => {
    const poly = square(-105.1, 39.6, 0.2)
    const expected = new Set(
      h3.polygonToCellsExperimental((densifyPlanar(poly, 0.02) as Polygon).coordinates, 8, h3.POLYGON_TO_CELLS_FLAGS.containmentOverlapping, true),
    )
    const result = analyze(poly, 'h3', 8)
    expect(result.count.quality).toBe('exact')
    expect(Number(result.count.count)).toBe(expected.size)
  })

  it('reports every resolution at which one cell contains the geometry', () => {
    const result = analyze({ type: 'Point', coordinates: [-95.17, 43.4] }, 'h3', 10)
    expect(result.fitsAt).toEqual(Array.from({ length: 16 }, (_, i) => i))
    expect(result.smallest!.level).toBe(15)
  })

  it('walks lines so every crossed cell is counted', () => {
    const line = { type: 'LineString' as const, coordinates: [[-105, 39.6], [-104.5, 39.9]] }
    const result = analyze(line, 'h3', 7)
    const vertexCells = new Set(line.coordinates.map(([lng, lat]) => h3.latLngToCell(lat, lng, 7)))
    expect(Number(result.count.count)).toBeGreaterThan(vertexCells.size)
  })
})
