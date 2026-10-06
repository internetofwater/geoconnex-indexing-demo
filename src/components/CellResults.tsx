import type { CellQuery } from '../hooks/useCellQueries'
import { formatArea } from '../lib/geo'
import { itemsUrl, type GeoconnexFeature } from '../lib/geoconnex'
import { cellAreaKm2, GRID_META, type GridKind } from '../lib/grids'
import { FeatureList } from './FeatureList'

interface Props {
  kind: GridKind
  query: CellQuery
  onLoadMore: () => void
  onClear: () => void
  onZoom: (f: GeoconnexFeature) => void
  onAnalyze: (iri: string) => void
}

export function CellResults({ kind, query, onLoadMore, onClear, onZoom, onAnalyze }: Props) {
  const meta = GRID_META[kind]
  const { cell, count, features } = query
  return (
    <section className="cell-results" style={{ borderColor: meta.color }}>
      <header>
        <span className="swatch" style={{ background: meta.color }} />
        <div className="cell-title">
          <strong>
            {meta.label} {meta.levelName.toLowerCase()} {cell.level}
          </strong>
          <code>{cell.id}</code>
        </div>
        <button type="button" className="icon-btn" onClick={onClear} aria-label={`Clear ${meta.label} selection`}>
          ×
        </button>
      </header>
      <div className="muted small">Cell area {formatArea(cellAreaKm2(cell))}</div>

      <div className="count-line">
        {count === undefined ? (
          <span className="muted">Counting features…</span>
        ) : count === null ? (
          <span className="muted">{query.countError ? `Count failed: ${query.countError}` : 'Count unavailable'}</span>
        ) : (
          <>
            <span className="big-number">{count.toLocaleString()}</span> feature{count === 1 ? '' : 's'}{' '}
            <span className="muted">fully within this cell</span>
          </>
        )}
      </div>

      {query.error && <div className="error">{query.error}</div>}
      <FeatureList features={features} onZoom={onZoom} onAnalyze={onAnalyze} />
      {query.loading && <div className="muted small">Loading features…</div>}
      {!query.loading && query.hasNext && (
        <button type="button" className="secondary" onClick={onLoadMore}>
          Load more ({features.length.toLocaleString()}
          {typeof count === 'number' ? ` of ${count.toLocaleString()}` : ''} shown)
        </button>
      )}
      {!query.loading && !query.error && features.length === 0 && count === 0 && (
        <div className="muted small">No features fully within this cell.</div>
      )}

      <details className="cql">
        <summary>CQL filter</summary>
        <code>{query.filter}</code>
        <a href={itemsUrl({ filter: query.filter, limit: 50 }, 'html')} target="_blank" rel="noreferrer">
          Open on features.geoconnex.us ↗
        </a>
      </details>
    </section>
  )
}
