import * as h3 from 'h3-js'
import { describe, expect, it } from 'vitest'
import { cellAt, viewportCells } from '../grids'

describe('cellAt', () => {
  it('returns an S2 cell at the requested level with a closed ring', () => {
    const cell = cellAt('s2', -104.99, 39.74, 10)
    expect(cell.level).toBe(10)
    expect(cell.ring[0]).toEqual(cell.ring[cell.ring.length - 1])
  })

  it('returns the H3 cell containing the point', () => {
    const cell = cellAt('h3', -104.99, 39.74, 6)
    expect(cell.id).toBe(h3.latLngToCell(39.74, -104.99, 6))
    expect(cell.level).toBe(6)
  })

  it('densifies coarse cell edges so they follow great circles', () => {
    expect(cellAt('s2', -104.99, 39.74, 2).ring.length).toBeGreaterThan(5)
    expect(cellAt('s2', -104.99, 39.74, 14).ring.length).toBe(5)
  })
})

describe('viewportCells', () => {
  const bounds = { west: -105.6, south: 39.3, east: -104.4, north: 40.1 }

  it('enumerates cells for a reasonable view', () => {
    const v = viewportCells('h3', bounds, 6, 4000)
    expect(v.tooMany).toBe(false)
    expect(v.cells.length).toBeGreaterThan(100)
  })

  it('refuses to enumerate when the estimate exceeds the limit', () => {
    const v = viewportCells('s2', bounds, 18, 4000)
    expect(v.tooMany).toBe(true)
    expect(v.cells).toHaveLength(0)
  })

  it('handles views that cross the antimeridian', () => {
    const v = viewportCells('h3', { west: 170, south: -20, east: 190, north: -10 }, 2, 4000)
    expect(v.tooMany).toBe(false)
    expect(v.cells.length).toBeGreaterThan(0)
  })
})
