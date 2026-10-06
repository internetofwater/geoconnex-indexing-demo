import type { Geometry } from 'geojson'
import type { GridAnalysis } from './analysis'
import type { AnalysisRequest, AnalysisResponse } from './analysis.worker'
import type { GridKind } from './grids'

/**
 * Runs analyses in a dedicated worker. If a new request arrives while one is still
 * running (e.g. the user drags the N slider), the busy worker is terminated rather
 * than letting stale work queue up.
 */
export class AnalysisClient {
  private worker: Worker | null = null
  private busy = false
  private reqId = 0
  private kind: GridKind
  private rejectPending: ((err: Error) => void) | null = null

  constructor(kind: GridKind) {
    this.kind = kind
  }

  run(geometry: Geometry, level: number): Promise<GridAnalysis> {
    if (this.busy) this.dispose()
    const worker = (this.worker ??= new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' }))
    const reqId = ++this.reqId
    this.busy = true
    return new Promise((resolve, reject) => {
      this.rejectPending = reject
      worker.onmessage = (e: MessageEvent<AnalysisResponse>) => {
        if (e.data.reqId !== reqId) return
        this.busy = false
        if (e.data.ok) resolve(e.data.result)
        else reject(new Error(e.data.error))
      }
      worker.onerror = (e) => {
        this.busy = false
        reject(new Error(e.message || 'Analysis worker failed'))
      }
      const msg: AnalysisRequest = { reqId, geometry, kind: this.kind, level }
      worker.postMessage(msg)
    })
  }

  dispose() {
    this.worker?.terminate()
    this.rejectPending?.(new DOMException('Superseded by a newer analysis', 'AbortError'))
    this.rejectPending = null
    this.worker = null
    this.busy = false
  }
}
