/// <reference lib="webworker" />
import type { Geometry } from 'geojson'
import { analyze } from './analysis'
import type { GridKind } from './grids'

export interface AnalysisRequest {
  reqId: number
  geometry: Geometry
  kind: GridKind
  level: number
}

export type AnalysisResponse =
  | { reqId: number; ok: true; result: ReturnType<typeof analyze> }
  | { reqId: number; ok: false; error: string }

self.onmessage = (e: MessageEvent<AnalysisRequest>) => {
  const { reqId, geometry, kind, level } = e.data
  let msg: AnalysisResponse
  try {
    msg = { reqId, ok: true, result: analyze(geometry, kind, level) }
  } catch (err) {
    msg = { reqId, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  self.postMessage(msg)
}
