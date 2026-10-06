import { useMemo, useState } from 'react'
import { CellResults } from './components/CellResults'
import { IriPanel } from './components/IriPanel'
import { MapView, type ResultFeature } from './components/MapView'
import { useCellQueries } from './hooks/useCellQueries'
import { useIriAnalysis } from './hooks/useIriAnalysis'
import { formatArea, geometryBounds, type Bounds } from './lib/geo'
import type { GeoconnexFeature } from './lib/geoconnex'
import { avgCellAreaKm2, cellAt, GRID_KINDS, GRID_META, viewportCells, type GridCell, type GridKind } from './lib/grids'

/** Max grid cells drawn for the current viewport, per grid. */
const VIEWPORT_CELL_LIMIT = 4000

export default function App() {
  const [levels, setLevels] = useState<Record<GridKind, number>>({ s2: 10, h3: 6 })
  const [visible, setVisible] = useState<Record<GridKind, boolean>>({ s2: true, h3: true })
  const [view, setView] = useState<{ bounds: Bounds; zoom: number } | null>(null)
  const [fitRequest, setFitRequest] = useState<{ bounds: Bounds; key: number } | null>(null)
  const [iriInput, setIriInput] = useState('')
  const [showCover, setShowCover] = useState(true)

  const cellQueries = useCellQueries()
  const iri = useIriAnalysis()

  const grids = useMemo(() => {
    const out = {} as Record<GridKind, ReturnType<typeof viewportCells> | null>
    for (const k of GRID_KINDS) out[k] = view && visible[k] ? viewportCells(k, view.bounds, levels[k], VIEWPORT_CELL_LIMIT) : null
    return out
  }, [view, visible, levels])

  const gridCells = useMemo(() => ({ s2: grids.s2?.cells ?? [], h3: grids.h3?.cells ?? [] }), [grids])

  const selectedCells = useMemo(
    () => GRID_KINDS.flatMap((k) => (cellQueries.queries[k] ? [cellQueries.queries[k].cell] : [])),
    [cellQueries.queries],
  )

  const resultFeatures = useMemo<ResultFeature[]>(
    () =>
      GRID_KINDS.flatMap((k) =>
        (cellQueries.queries[k]?.features ?? []).filter((f) => f.geometry).map((feature) => ({ kind: k, feature })),
      ),
    [cellQueries.queries],
  )

  const iriLayers = useMemo(() => {
    const cover: GridCell[] = []
    const smallest: GridCell[] = []
    for (const k of GRID_KINDS) {
      const s = iri.results[k]
      const a = s?.state === 'done' ? s.analysis : s?.state === 'running' ? s.previous : undefined
      if (!a) continue
      if (showCover) cover.push(...a.display)
      if (a.smallest) smallest.push(a.smallest)
    }
    return { cover, smallest }
  }, [iri.results, showCover])

  const fitTo = (bounds: Bounds | null) => {
    if (bounds) setFitRequest({ bounds, key: Date.now() })
  }

  const handleCellClick = (lng: number, lat: number) => {
    for (const k of GRID_KINDS) {
      if (visible[k]) cellQueries.run(cellAt(k, lng, lat, levels[k]))
    }
  }

  const analyzeIri = async (value: string) => {
    setIriInput(value)
    const feature = await iri.load(value)
    if (feature) fitTo(geometryBounds(feature.geometry))
  }

  const zoomToFeature = (f: GeoconnexFeature) => fitTo(f.geometry ? geometryBounds(f.geometry) : null)

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="app-header">
          <h1>Geoconnex spatial indexing</h1>
          <p className="muted small">
            Compare <strong style={{ color: GRID_META.s2.color }}>S2</strong> and{' '}
            <strong style={{ color: GRID_META.h3.color }}>H3</strong> cells against features from{' '}
            <a href="https://features.geoconnex.us/collections/GeoconnexFeatures" target="_blank" rel="noreferrer">
              features.geoconnex.us
            </a>
            .
          </p>
        </header>

        <section className="panel">
          <h2>Grids</h2>
          {GRID_KINDS.map((k) => {
            const meta = GRID_META[k]
            const g = grids[k]
            return (
              <div key={k} className="grid-control">
                <label className="toggle">
                  <input type="checkbox" checked={visible[k]} onChange={(e) => setVisible((v) => ({ ...v, [k]: e.target.checked }))} />
                  <span className="swatch" style={{ background: meta.color }} />
                  <strong>{meta.label}</strong>
                  <span className="muted small">
                    {meta.levelName.toLowerCase()} {levels[k]} · avg {formatArea(avgCellAreaKm2(k, levels[k]))}
                  </span>
                </label>
                <input
                  type="range"
                  min={meta.min}
                  max={meta.max}
                  value={levels[k]}
                  disabled={!visible[k]}
                  onChange={(e) => setLevels((l) => ({ ...l, [k]: Number(e.target.value) }))}
                  style={{ accentColor: meta.color }}
                  aria-label={`${meta.label} ${meta.levelName}`}
                />
                {g &&
                  (g.tooMany ? (
                    <div className="warn small">
                      ~{g.estimate.toLocaleString()} cells in view — zoom in or lower the {meta.levelName.toLowerCase()} to draw the grid
                      (clicking still works).
                    </div>
                  ) : (
                    <div className="muted small">{g.cells.length.toLocaleString()} cells in view</div>
                  ))}
              </div>
            )
          })}
          {view && <div className="muted small">Map zoom {view.zoom.toFixed(1)}</div>}
        </section>

        <IriPanel
          inputValue={iriInput}
          onInputChange={setIriInput}
          onSubmit={analyzeIri}
          onClear={iri.clear}
          status={iri.status}
          feature={iri.feature}
          levels={iri.levels}
          onLevelChange={iri.setLevel}
          results={iri.results}
          showCover={showCover}
          onShowCoverChange={setShowCover}
        />
        <section className="panel">
          <h2>Features in a cell</h2>
          <p className="muted small">Click the map to list the features that lie fully within the cell under the cursor, for each visible grid.</p>
          {GRID_KINDS.map((k) => {
            const q = cellQueries.queries[k]
            return q ? (
              <CellResults
                key={k}
                kind={k}
                query={q}
                onLoadMore={() => cellQueries.loadMore(k)}
                onClear={() => cellQueries.clear(k)}
                onZoom={zoomToFeature}
                onAnalyze={analyzeIri}
              />
            ) : null
          })}
        </section>

      </aside>

      <main className="map-container">
        <MapView
          gridCells={gridCells}
          selectedCells={selectedCells}
          resultFeatures={resultFeatures}
          iriFeature={iri.feature}
          iriCover={iriLayers.cover}
          iriSmallest={iriLayers.smallest}
          fitRequest={fitRequest}
          onCellClick={handleCellClick}
          onViewChange={(bounds, zoom) => setView({ bounds, zoom })}
        />
        <div className="legend">
          <div>
            <span className="swatch" style={{ background: GRID_META.s2.color }} /> S2
          </div>
          <div>
            <span className="swatch" style={{ background: GRID_META.h3.color }} /> H3
          </div>
          <div>
            <span className="swatch dashed" /> smallest containing cell
          </div>
        </div>
      </main>
    </div>
  )
}
