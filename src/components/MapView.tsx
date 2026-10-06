import type { Feature, FeatureCollection, Geometry, Polygon } from 'geojson'
import * as maplibregl from 'maplibre-gl'
import type { GeoJSONSource, MapMouseEvent } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
// MapLibre 6 resolves its worker relative to import.meta.url, which breaks under Vite's
// dependency pre-bundling. Let Vite bundle the worker (with its shared chunk) instead.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { useEffect, useRef, useState } from 'react'
import type { Bounds } from '../lib/geo'
import { GRID_META, type GridCell, type GridKind } from '../lib/grids'

maplibregl.setWorkerUrl(maplibreWorkerUrl)

const STYLE_URL = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
const S2_COLOR = GRID_META.s2.color
const H3_COLOR = GRID_META.h3.color

export interface ResultFeature {
  kind: GridKind
  feature: Feature<Geometry, { id: string; feature_name: string | null }>
}

export interface MapViewProps {
  gridCells: Record<GridKind, GridCell[]>
  selectedCells: GridCell[]
  resultFeatures: ResultFeature[]
  iriFeature: Feature | null
  iriCover: GridCell[]
  iriSmallest: GridCell[]
  /** Change `key` to request a new fit. */
  fitRequest: { bounds: Bounds; key: number } | null
  onCellClick: (lng: number, lat: number) => void
  onViewChange: (bounds: Bounds, zoom: number) => void
}

const kindColor: maplibregl.ExpressionSpecification = ['match', ['get', 'kind'], 's2', S2_COLOR, H3_COLOR]
const isPolygon: maplibregl.ExpressionSpecification = ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false]
const isLine: maplibregl.ExpressionSpecification = ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false]
const isPoint: maplibregl.ExpressionSpecification = ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false]

function cellsToGeoJson(cells: GridCell[]): FeatureCollection<Polygon> {
  return {
    type: 'FeatureCollection',
    features: cells.map((c) => ({
      type: 'Feature',
      properties: { kind: c.kind, id: c.id, level: c.level },
      geometry: { type: 'Polygon', coordinates: [c.ring] },
    })),
  }
}

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }

function addLayers(map: maplibregl.Map) {
  for (const id of ['grid-s2', 'grid-h3', 'iri-cover', 'iri-smallest', 'iri-feature', 'selected', 'results']) {
    map.addSource(id, { type: 'geojson', data: EMPTY })
  }

  map.addLayer({ id: 'grid-h3-fill', type: 'fill', source: 'grid-h3', paint: { 'fill-color': H3_COLOR, 'fill-opacity': 0.02 } })
  map.addLayer({ id: 'grid-s2-fill', type: 'fill', source: 'grid-s2', paint: { 'fill-color': S2_COLOR, 'fill-opacity': 0.02 } })
  map.addLayer({ id: 'grid-h3-line', type: 'line', source: 'grid-h3', paint: { 'line-color': H3_COLOR, 'line-width': 1, 'line-opacity': 0.7 } })
  map.addLayer({ id: 'grid-s2-line', type: 'line', source: 'grid-s2', paint: { 'line-color': S2_COLOR, 'line-width': 1.2, 'line-opacity': 0.8 } })

  map.addLayer({ id: 'iri-cover-fill', type: 'fill', source: 'iri-cover', paint: { 'fill-color': kindColor, 'fill-opacity': 0.18 } })
  map.addLayer({ id: 'iri-cover-line', type: 'line', source: 'iri-cover', paint: { 'line-color': kindColor, 'line-width': 0.8 } })
  map.addLayer({
    id: 'iri-smallest-line',
    type: 'line',
    source: 'iri-smallest',
    paint: { 'line-color': kindColor, 'line-width': 3, 'line-dasharray': [2, 1.5] },
  })

  map.addLayer({ id: 'iri-feature-fill', type: 'fill', source: 'iri-feature', filter: isPolygon, paint: { 'fill-color': '#111827', 'fill-opacity': 0.12 } })
  map.addLayer({ id: 'iri-feature-line', type: 'line', source: 'iri-feature', filter: ['!', isPoint], paint: { 'line-color': '#111827', 'line-width': 2 } })
  map.addLayer({
    id: 'iri-feature-point',
    type: 'circle',
    source: 'iri-feature',
    filter: isPoint,
    paint: { 'circle-color': '#111827', 'circle-radius': 6, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
  })

  map.addLayer({ id: 'selected-fill', type: 'fill', source: 'selected', paint: { 'fill-color': kindColor, 'fill-opacity': 0.22 } })
  map.addLayer({ id: 'selected-line', type: 'line', source: 'selected', paint: { 'line-color': kindColor, 'line-width': 3.5 } })

  map.addLayer({ id: 'results-fill', type: 'fill', source: 'results', filter: isPolygon, paint: { 'fill-color': kindColor, 'fill-opacity': 0.25 } })
  map.addLayer({
    id: 'results-line',
    type: 'line',
    source: 'results',
    filter: ['any', isLine, isPolygon],
    paint: { 'line-color': kindColor, 'line-width': ['match', ['geometry-type'], ['LineString', 'MultiLineString'], 2.5, 1] },
  })
  map.addLayer({
    id: 'results-point',
    type: 'circle',
    source: 'results',
    filter: isPoint,
    paint: { 'circle-color': kindColor, 'circle-radius': 4.5, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 },
  })
}

function hasWebGL2(): boolean {
  try {
    return !!document.createElement('canvas').getContext('webgl2')
  } catch {
    return false
  }
}

interface Hover {
  x: number
  y: number
  lines: { kind: GridKind; text: string }[]
}

export function MapView(props: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const [ready, setReady] = useState(false)
  const [hover, setHover] = useState<Hover | null>(null)
  // Without WebGL2 MapLibre throws; keep the sidebar usable (IRI analysis still works).
  const [mapError] = useState(() => (hasWebGL2() ? null : 'this browser does not support WebGL2.'))
  // Keep the latest callbacks without re-binding map listeners.
  const callbacks = useRef({ onCellClick: props.onCellClick, onViewChange: props.onViewChange })
  useEffect(() => {
    callbacks.current = { onCellClick: props.onCellClick, onViewChange: props.onViewChange }
  })

  useEffect(() => {
    if (mapError) return
    const map = new maplibregl.Map({
      container: containerRef.current!,
      style: STYLE_URL,
      center: [-105.0, 39.7],
      zoom: 8.5,
      attributionControl: { compact: true },
    })
    mapRef.current = map
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right')

    const emitView = () => {
      const b = map.getBounds()
      callbacks.current.onViewChange({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() }, map.getZoom())
    }
    map.on('load', () => {
      addLayers(map)
      setReady(true)
      emitView()
    })
    map.on('moveend', emitView)
    map.on('click', (e) => callbacks.current.onCellClick(e.lngLat.lng, e.lngLat.lat))
    map.on('mousemove', (e: MapMouseEvent) => {
      const layers = ['grid-s2-fill', 'grid-h3-fill'].filter((l) => map.getLayer(l))
      const hits = map.queryRenderedFeatures(e.point, { layers })
      const seen = new Set<string>()
      const lines = hits
        .map((f) => {
          const kind = f.layer.id === 'grid-s2-fill' ? 's2' : 'h3'
          return { kind: kind as GridKind, text: `${GRID_META[kind].label} ${f.properties.level} · ${f.properties.id}` }
        })
        .filter((l) => !seen.has(l.kind) && seen.add(l.kind))
        .sort((a, b) => a.kind.localeCompare(b.kind))
      setHover(lines.length ? { x: e.point.x, y: e.point.y, lines } : null)
    })
    map.on('mouseout', () => setHover(null))
    return () => map.remove()
  }, [mapError])

  const { gridCells, selectedCells, resultFeatures, iriFeature, iriCover, iriSmallest, fitRequest } = props

  useEffect(() => {
    if (!ready) return
    const map = mapRef.current!
    ;(map.getSource('grid-s2') as GeoJSONSource).setData(cellsToGeoJson(gridCells.s2))
    ;(map.getSource('grid-h3') as GeoJSONSource).setData(cellsToGeoJson(gridCells.h3))
  }, [ready, gridCells])

  useEffect(() => {
    if (!ready) return
    ;(mapRef.current!.getSource('selected') as GeoJSONSource).setData(cellsToGeoJson(selectedCells))
  }, [ready, selectedCells])

  useEffect(() => {
    if (!ready) return
    const data: FeatureCollection = {
      type: 'FeatureCollection',
      features: resultFeatures.map(({ kind, feature }) => ({ ...feature, properties: { ...feature.properties, kind } })),
    }
    ;(mapRef.current!.getSource('results') as GeoJSONSource).setData(data)
  }, [ready, resultFeatures])

  useEffect(() => {
    if (!ready) return
    const map = mapRef.current!
    ;(map.getSource('iri-feature') as GeoJSONSource).setData(iriFeature ? { type: 'FeatureCollection', features: [iriFeature] } : EMPTY)
    ;(map.getSource('iri-cover') as GeoJSONSource).setData(cellsToGeoJson(iriCover))
    ;(map.getSource('iri-smallest') as GeoJSONSource).setData(cellsToGeoJson(iriSmallest))
  }, [ready, iriFeature, iriCover, iriSmallest])

  useEffect(() => {
    if (!ready || !fitRequest) return
    const { west, south, east, north } = fitRequest.bounds
    mapRef.current!.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: 60, maxZoom: 15, duration: 800 },
    )
  }, [ready, fitRequest])

  return (
    <div className="map-wrap">
      <div ref={containerRef} className="map" />
      {mapError && <div className="map-error">The map could not be created: {mapError}</div>}
      {hover && (
        <div className="map-hover" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          {hover.lines.map((l) => (
            <div key={l.kind} style={{ color: GRID_META[l.kind].color }}>
              {l.text}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
