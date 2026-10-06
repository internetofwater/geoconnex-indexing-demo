import { describe, expect, it } from 'vitest'
import { cellFilter, itemsUrl } from '../geoconnex'

describe('cellFilter', () => {
  it('builds a CQL spatial filter the pygeoapi server accepts', () => {
    const f = cellFilter([
      [-105.1, 39.6],
      [-104.9, 39.6],
      [-104.9, 39.8],
      [-105.1, 39.6],
    ])
    expect(f).toBe('WITHIN(geometry, POLYGON((-105.1 39.6, -104.9 39.6, -104.9 39.8, -105.1 39.6)))')
  })

  it('URL-encodes the filter', () => {
    const url = itemsUrl({ filter: "id='https://geoconnex.us/ref/states/08'", limit: 1 })
    expect(url).toContain('filter=id%3D%27https%3A%2F%2Fgeoconnex.us%2Fref%2Fstates%2F08%27')
  })
})
