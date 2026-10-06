import type { GeoconnexFeature } from '../lib/geoconnex'

interface Props {
  features: GeoconnexFeature[]
  onZoom: (f: GeoconnexFeature) => void
  onAnalyze: (iri: string) => void
}

export function FeatureList({ features, onZoom, onAnalyze }: Props) {
  if (features.length === 0) return null
  return (
    <ul className="feature-list">
      {features.map((f) => {
        const iri = f.properties.id ?? String(f.id)
        return (
          <li key={iri}>
            <div className="feature-head">
              <span className="feature-name">{f.properties.feature_name || '(unnamed)'}</span>
              {f.properties.geoconnex_sitemap && <span className="badge">{f.properties.geoconnex_sitemap}</span>}
            </div>
            <a className="iri" href={iri} target="_blank" rel="noreferrer">
              {iri}
            </a>
            <div className="feature-actions">
              <span className="muted">{f.geometry?.type ?? 'no geometry'}</span>
              {f.geometry && (
                <button type="button" className="link-btn" onClick={() => onZoom(f)}>
                  Zoom
                </button>
              )}
              <button type="button" className="link-btn" onClick={() => onAnalyze(iri)}>
                Analyze coverage
              </button>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
