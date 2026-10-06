import type { FormEvent } from 'react'
import type { AnalysisState, LookupStatus } from '../hooks/useIriAnalysis'
import type { GridAnalysis } from '../lib/analysis'
import { formatArea, formatLength, summarizeGeometry } from '../lib/geo'
import type { GeoconnexFeature } from '../lib/geoconnex'
import { avgCellAreaKm2, cellAreaKm2, GRID_KINDS, GRID_META, type GridKind } from '../lib/grids'

const EXAMPLES = [
  { label: 'Colorado (state)', iri: 'https://geoconnex.us/ref/states/08' },
  { label: 'Animas HUC8', iri: 'https://geoconnex.us/ref/hu08/14080104' },
  { label: 'Animas River mainstem', iri: 'https://geoconnex.us/ref/mainstems/35394' },
  { label: 'Okoboji gage', iri: 'https://geoconnex.us/ref/gages/1018035' },
]

interface Props {
  inputValue: string
  onInputChange: (v: string) => void
  onSubmit: (iri: string) => void
  onClear: () => void
  status: LookupStatus
  feature: GeoconnexFeature | null
  levels: Record<GridKind, number>
  onLevelChange: (kind: GridKind, level: number) => void
  results: Partial<Record<GridKind, AnalysisState>>
  showCover: boolean
  onShowCoverChange: (v: boolean) => void
}

const QUALITY_PREFIX: Record<GridAnalysis['count']['quality'], string> = { exact: '', upperBound: '≤\u00a0', estimate: '≈\u00a0' }

function formatCount(n: bigint): string {
  return n.toLocaleString()
}

function analysisOf(s: AnalysisState | undefined): GridAnalysis | undefined {
  if (!s) return undefined
  return s.state === 'done' ? s.analysis : s.state === 'running' ? s.previous : undefined
}

export function IriPanel(props: Props) {
  const { inputValue, onInputChange, onSubmit, status, feature, levels, results } = props

  const submit = (e: FormEvent) => {
    e.preventDefault()
    onSubmit(inputValue)
  }

  const summary = feature ? summarizeGeometry(feature.geometry) : null

  return (
    <section className="panel">
      <h2>Feature coverage</h2>
      <p className="muted small">Look up a Geoconnex IRI and compute how S2 and H3 cells cover its geometry.</p>
      <form className="iri-form" onSubmit={submit}>
        <input
          type="url"
          placeholder="https://geoconnex.us/ref/hu08/14080104"
          value={inputValue}
          onChange={(e) => onInputChange(e.target.value)}
          aria-label="Geoconnex IRI"
        />
        <button type="submit" disabled={status.state === 'loading' || !inputValue.trim()}>
          {status.state === 'loading' ? 'Loading…' : 'Analyze'}
        </button>
      </form>
      <div className="examples">
        {EXAMPLES.map((ex) => (
          <button
            key={ex.iri}
            type="button"
            className="chip"
            onClick={() => {
              onInputChange(ex.iri)
              onSubmit(ex.iri)
            }}
          >
            {ex.label}
          </button>
        ))}
      </div>

      {status.state === 'notfound' && <div className="error">No feature with id {status.iri} on features.geoconnex.us.</div>}
      {status.state === 'error' && <div className="error">{status.message}</div>}

      {feature && summary && (
        <div className="iri-result">
          <div className="feature-head">
            <span className="feature-name">{feature.properties.feature_name || '(unnamed)'}</span>
            {feature.properties.geoconnex_sitemap && <span className="badge">{feature.properties.geoconnex_sitemap}</span>}
            <button type="button" className="icon-btn" onClick={props.onClear} aria-label="Clear feature">
              ×
            </button>
          </div>
          <details>
            <summary className="muted small">
              {summary.type} · {summary.vertices.toLocaleString()} vertices
            </summary>
            <div className="muted small">
              {summary.areaKm2 > 0 && <div>Area ≈ {formatArea(summary.areaKm2)}</div>}
              {summary.lengthKm > 0 && <div>Length ≈ {formatLength(summary.lengthKm)}</div>}
              <a className="iri" href={feature.properties.id} target="_blank" rel="noreferrer">
                {feature.properties.id}
              </a>
            </div>
          </details>

          <table className="analysis">
            <thead>
              <tr>
                <th />
                {GRID_KINDS.map((k) => (
                  <th key={k} style={{ color: GRID_META[k].color }}>
                    {GRID_META[k].label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">
                  Smallest single cell containing it
                  <span className="hint">finest level where one cell fully covers the geometry</span>
                </th>
                {GRID_KINDS.map((k) => {
                  const a = analysisOf(results[k])
                  const s = results[k]
                  if (s?.state === 'error') return <td key={k} className="error-text">{s.message}</td>
                  if (!a) return <td key={k} className="muted">…</td>
                  if (!a.smallest) return <td key={k} className="muted small">{a.smallestNote}</td>
                  return (
                    <td key={k}>
                      <div className="big-number">
                        {GRID_META[k].levelName.slice(0, 3).toLowerCase()} {a.smallest.level}
                      </div>
                      <code className="small">{a.smallest.id}</code>
                      <div className="muted small">{formatArea(cellAreaKm2(a.smallest))}</div>
                      {a.fitsAt && a.fitsAt.length !== a.smallest.level + 1 && (
                        <div className="warn small">
                          Fits in one cell at res {a.fitsAt.join(', ')} but not{' '}
                          {Array.from({ length: a.smallest.level }, (_, i) => i)
                            .filter((r) => !a.fitsAt!.includes(r))
                            .join(', ')}{' '}
                          — H3 children can extend outside their parent.
                        </div>
                      )}
                    </td>
                  )
                })}
              </tr>
              <tr>
                <th scope="row">
                  Level N
                  <span className="hint">resolution used for the cell count below</span>
                </th>
                {GRID_KINDS.map((k) => (
                  <td key={k}>
                    <input
                      type="range"
                      min={GRID_META[k].min}
                      max={GRID_META[k].max}
                      value={levels[k]}
                      onChange={(e) => props.onLevelChange(k, Number(e.target.value))}
                      style={{ accentColor: GRID_META[k].color }}
                      aria-label={`${GRID_META[k].label} level N`}
                    />
                    <div className="small">
                      <strong>N = {levels[k]}</strong>{' '}
                      <span className="muted">avg {formatArea(avgCellAreaKm2(k, levels[k]))}</span>
                    </div>
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">
                  Cells at level N
                  <span className="hint">cells that intersect the geometry</span>
                </th>
                {GRID_KINDS.map((k) => {
                  const s = results[k]
                  const a = analysisOf(s)
                  if (s?.state === 'error') return <td key={k} />
                  if (!a) return <td key={k} className="muted">computing…</td>
                  const stale = s?.state === 'running'
                  return (
                    <td key={k} className={stale ? 'stale' : undefined}>
                      <div className="big-number">
                        {QUALITY_PREFIX[a.count.quality]}
                        {formatCount(a.count.count)}
                      </div>
                      {a.count.note && <div className="muted small">{a.count.note}</div>}
                      <div className="muted small">{stale ? 'recomputing…' : `${a.ms.toFixed(0)} ms`}</div>
                    </td>
                  )
                })}
              </tr>
            </tbody>
          </table>

          <label className="toggle">
            <input type="checkbox" checked={props.showCover} onChange={(e) => props.onShowCoverChange(e.target.checked)} />
            Draw coverings on map
          </label>
          {props.showCover &&
            GRID_KINDS.map((k) => {
              const note = analysisOf(results[k])?.displayNote
              return note ? (
                <div key={k} className="muted small">
                  <strong style={{ color: GRID_META[k].color }}>{GRID_META[k].label}:</strong> {note}
                </div>
              ) : null
            })}
        </div>
      )}
    </section>
  )
}
