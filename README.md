# Geoconnex spatial indexing demo

A small React + MapLibre app for comparing **S2**, **H3** and **geohash** as spatial indexes for
[Geoconnex](https://geoconnex.us) features served by
[features.geoconnex.us](https://features.geoconnex.us/collections/GeoconnexFeatures).

```sh
npm install
npm run dev     # http://localhost:5173
npm test        # unit tests (vitest)
npm run build
```

## What it does

**Grids.** Draws the S2, H3 and geohash cells covering the current map view. Each grid has
its own level slider (S2 0–30, H3 0–15, geohash precision 1–12). If a view would need more than ~4,000 cells, the grid
isn't drawn, but clicking still works.

**Features in a cell.** Clicking the map selects the cell under the cursor for each
visible grid and queries the feature server with a CQL spatial filter on the
cell's exact polygon, returning only features that lie fully inside it. (`bbox`, and
`INTERSECTS`, would also return the many large polygons that span much of the US.)

```
WITHIN(geometry, POLYGON((lng lat, ...)))
```

The total comes from `resulttype=hits`. Features load 50 at a time and are drawn on the
map. Each result can be zoomed to, or sent to the coverage analyzer.

**Feature coverage.** Paste a Geoconnex IRI (e.g. `https://geoconnex.us/ref/hu08/14080104`).
The app fetches the feature with `filter=id='<iri>'`, trying the http/https variant if
needed, then computes for each grid:

- **The smallest single cell that contains it**: the finest level where one cell covers
  the whole geometry. H3 cells are not nested, so a geometry can fit in one res‑2 cell but
  not in any single res‑1 cell. The app tests every resolution and flags this case.
- **The number of level‑N cells that intersect it.** N has its own slider per grid and
  defaults to 13 for S2 and H3. Geohash tops out at precision 12, so it defaults to 8
  (about 38 × 19 m). The count is exact when it can be enumerated in the browser; otherwise
  it's estimated (marked `≈`). Estimates use area ÷ local cell area plus half the boundary
  cells, and land within about 1–4% of exact counts on test features.
- Optionally, it draws the covering on the map. The **Mixed levels** toggle (on by
  default) switches between two views. The normalized covering merges interior cells
  into coarser parents, leaving small cells only along the boundary. The uniform view
  draws every level‑N cell. Either view is drawn only if it has 3,000 cells or fewer; a
  collapsible note in the panel explains the mixed view.

The analysis runs in a Web Worker, so dragging N doesn't block the UI.

## How the grids differ here

- **S2**: nested quadtree cells with geodesic edges. Polygons are covered with s2js's
  `RegionCoverer`.
- **H3**: hexagons that don't nest exactly. Polygons use `polygonToCells` in overlapping
  mode.
- **Geohash**: nested lng/lat rectangles, using a small built-in implementation
  (`src/lib/geohash.ts`). Their edges are straight in lng/lat, the same way PostGIS sees
  them, so no densification is needed. Polygons are covered by recursive subdivision, and
  the smallest containing cell is the vertices' common prefix.

## Notes on the server and the libraries

- The pygeoapi CQL parser on features.geoconnex.us accepts the CQL1 spatial name
  `WITHIN`, not CQL2's `S_WITHIN`.
- `resulttype=hits` requires `limit >= 1`.
- PostGIS treats edges as planar lng/lat lines, while S2 and H3 treat them as geodesics.
  Cell boundaries are densified along great circles before they go into a CQL polygon, and
  feature geometries are densified in lng/lat before covering, so both sides agree.
- s2js's multi-member GeoJSON `RegionCoverer` overflows the stack on large MultiPolygons,
  so polygon parts are covered one at a time and merged.
- MapLibre 6 loads its worker relative to `import.meta.url`, which Vite's pre-bundling
  breaks. `MapView.tsx` imports the worker with `?worker&url` and calls `setWorkerUrl`.

## Layout

```
src/lib/geo.ts               geometry helpers (densify, area/length, bounds)
src/lib/grids.ts             S2/H3/geohash cell lookup, boundaries, viewport enumeration
src/lib/geohash.ts           geohash encode/decode
src/lib/geoconnex.ts         feature server client + CQL filter builder
src/lib/analysis.ts          smallest-containing-cell and level-N counts
src/lib/analysis.worker.ts   runs analysis off the main thread
src/hooks/                   cell query + IRI analysis state
src/components/              MapView, CellResults, IriPanel, FeatureList
```
