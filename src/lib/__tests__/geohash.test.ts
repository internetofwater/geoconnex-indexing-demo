import type { Polygon } from 'geojson'
import { describe, expect, it } from 'vitest'
import { analyze } from '../analysis'
import { cellSizeDeg, decodeBounds, encode } from '../geohash'
import { viewportCells } from '../grids'

describe('geohash', () => {
  it('encodes known reference values', () => {
    expect(encode(57.64911, 10.40744, 11)).toBe('u4pruydqqvj')
    expect(encode(42.6, -5.6, 5)).toBe('ezs42')
  })

  it('decodes to a rectangle containing the encoded point', () => {
    const b = decodeBounds(encode(39.74, -104.99, 7))
    expect(b.west).toBeLessThanOrEqual(-104.99)
    expect(b.east).toBeGreaterThan(-104.99)
    expect(b.south).toBeLessThanOrEqual(39.74)
    expect(b.north).toBeGreaterThan(39.74)
    const { width, height } = cellSizeDeg(7)
    expect(b.east - b.west).toBeCloseTo(width)
    expect(b.north - b.south).toBeCloseTo(height)
  })

  it('enumerates the cells covering a viewport', () => {
    const v = viewportCells('geohash', { west: -105.6, south: 39.3, east: -104.4, north: 40.1 }, 4, 4000)
    expect(v.tooMany).toBe(false)
    expect(new Set(v.cells.map((c) => c.id)).size).toBe(v.cells.length)
    expect(v.cells.every((c) => c.id.length === 4)).toBe(true)
  })
})

describe('analyze (geohash)', () => {
  const square: Polygon = {
    type: 'Polygon',
    coordinates: [
      [
        [-105.1, 39.6],
        [-104.9, 39.6],
        [-104.9, 39.8],
        [-105.1, 39.8],
        [-105.1, 39.6],
      ],
    ],
  }

  it('counts exactly the precision-N cells overlapping an axis-aligned rectangle', () => {
    const p = 6
    const { width, height } = cellSizeDeg(p)
    // For a lng/lat rectangle, the overlapping cells form a simple grid.
    const cols = Math.floor(-104.9 / width) - Math.floor(-105.1 / width) + 1
    const rows = Math.floor(39.8 / height) - Math.floor(39.6 / height) + 1
    const result = analyze(square, 'geohash', p)
    expect(result.count.quality).toBe('exact')
    expect(Number(result.count.count)).toBe(cols * rows)
  })

  it('finds the smallest containing cell as the common prefix', () => {
    const result = analyze(square, 'geohash', 6)
    const b = decodeBounds(result.smallest!.id)
    expect(b.west).toBeLessThanOrEqual(-105.1)
    expect(b.east).toBeGreaterThanOrEqual(-104.9)
    expect(b.south).toBeLessThanOrEqual(39.6)
    expect(b.north).toBeGreaterThanOrEqual(39.8)
  })

  it('treats a point as one cell, contained at precision 12', () => {
    const result = analyze({ type: 'Point', coordinates: [-95.17, 43.4] }, 'geohash', 9)
    expect(result.count.count).toBe(1n)
    expect(result.smallest!.level).toBe(12)
  })

  it('estimates when the boundary is too large to enumerate', () => {
    const big: Polygon = { type: 'Polygon', coordinates: [[[-109, 37], [-102, 37], [-102, 41], [-109, 41], [-109, 37]]] }
    const result = analyze(big, 'geohash', 10)
    expect(result.count.quality).toBe('estimate')
    expect(result.ms).toBeLessThan(5000)
  })
})
