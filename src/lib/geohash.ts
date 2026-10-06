import type { Bounds } from './geo'

/**
 * Minimal geohash implementation. A geohash cell is a plain lng/lat rectangle: each
 * character adds 5 bits, alternating longitude and latitude bisections (longitude first).
 */

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz'
const DECODE: Record<string, number> = Object.fromEntries([...BASE32].map((c, i) => [c, i]))

export const GEOHASH_CHARS = BASE32

export function encode(lat: number, lng: number, precision: number): string {
  let latLo = -90
  let latHi = 90
  let lngLo = -180
  let lngHi = 180
  let hash = ''
  let bit = 0
  let ch = 0
  let even = true
  while (hash.length < precision) {
    if (even) {
      const mid = (lngLo + lngHi) / 2
      if (lng >= mid) {
        ch = (ch << 1) | 1
        lngLo = mid
      } else {
        ch <<= 1
        lngHi = mid
      }
    } else {
      const mid = (latLo + latHi) / 2
      if (lat >= mid) {
        ch = (ch << 1) | 1
        latLo = mid
      } else {
        ch <<= 1
        latHi = mid
      }
    }
    even = !even
    if (++bit === 5) {
      hash += BASE32[ch]
      bit = 0
      ch = 0
    }
  }
  return hash
}

export function decodeBounds(hash: string): Bounds {
  let latLo = -90
  let latHi = 90
  let lngLo = -180
  let lngHi = 180
  let even = true
  for (const c of hash) {
    const v = DECODE[c]
    if (v === undefined) throw new Error(`Invalid geohash character "${c}" in ${hash}`)
    for (let b = 4; b >= 0; b--) {
      const on = (v >> b) & 1
      if (even) {
        const mid = (lngLo + lngHi) / 2
        if (on) lngLo = mid
        else lngHi = mid
      } else {
        const mid = (latLo + latHi) / 2
        if (on) latLo = mid
        else latHi = mid
      }
      even = !even
    }
  }
  return { west: lngLo, south: latLo, east: lngHi, north: latHi }
}

export function isValid(hash: string): boolean {
  return hash.length > 0 && [...hash].every((c) => c in DECODE)
}

/** Cell size in degrees at a precision. */
export function cellSizeDeg(precision: number): { width: number; height: number } {
  const bits = 5 * precision
  const lngBits = Math.ceil(bits / 2)
  const latBits = Math.floor(bits / 2)
  return { width: 360 / 2 ** lngBits, height: 180 / 2 ** latBits }
}

export function children(hash: string): string[] {
  return [...BASE32].map((c) => hash + c)
}
