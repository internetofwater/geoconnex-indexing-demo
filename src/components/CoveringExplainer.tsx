import { GRID_META, type GridKind } from '../lib/grids'

const SIZE = 160
const MAX_DEPTH = 4

/** A lumpy closed shape standing in for a watershed: radius varies with angle. */
function radiusAt(angle: number): number {
  return 58 + 10 * Math.sin(3 * angle) + 6 * Math.cos(5 * angle + 1)
}

function inside(x: number, y: number): boolean {
  const dx = x - SIZE / 2
  const dy = y - SIZE / 2
  return Math.hypot(dx, dy) <= radiusAt(Math.atan2(dy, dx))
}

interface Square {
  x: number
  y: number
  size: number
  state: 'inside' | 'boundary'
}

/** Sample a square on a fine grid to classify it as fully inside, fully outside, or mixed. */
function classify(x: number, y: number, size: number): 'inside' | 'outside' | 'mixed' {
  const n = 8
  let hits = 0
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) if (inside(x + (size * i) / n, y + (size * j) / n)) hits++
  }
  return hits === 0 ? 'outside' : hits === (n + 1) ** 2 ? 'inside' : 'mixed'
}

/** The same normalized covering the analysis produces, on a toy quadtree (like S2). */
function cover(x: number, y: number, size: number, depth: number, out: Square[]) {
  const c = classify(x, y, size)
  if (c === 'outside') return
  if (c === 'inside') out.push({ x, y, size, state: 'inside' })
  else if (depth === MAX_DEPTH) out.push({ x, y, size, state: 'boundary' })
  else {
    const h = size / 2
    cover(x, y, h, depth + 1, out)
    cover(x + h, y, h, depth + 1, out)
    cover(x, y + h, h, depth + 1, out)
    cover(x + h, y + h, h, depth + 1, out)
  }
}

const SQUARES: Square[] = []
cover(0, 0, SIZE, 0, SQUARES)

const OUTLINE = Array.from({ length: 120 }, (_, i) => {
  const a = (i / 120) * 2 * Math.PI
  const r = radiusAt(a)
  return `${(SIZE / 2 + r * Math.cos(a)).toFixed(1)},${(SIZE / 2 + r * Math.sin(a)).toFixed(1)}`
}).join(' ')

const CHILDREN: Record<GridKind, string> = { s2: '4', h3: '≈7', geohash: '32' }

interface Props {
  /** Grids currently drawing a mixed-level covering */
  kinds: GridKind[]
}

export function CoveringExplainer({ kinds }: Props) {
  const color = GRID_META[kinds[0] ?? 's2'].color
  return (
    <details className="explainer">
      <summary>Why do cells of different sizes cover the same polygon?</summary>
      <div className="explainer-body">
        <svg viewBox={`-1 -1 ${SIZE + 2} ${SIZE + 2}`} width={SIZE} height={SIZE} role="img" aria-label="A shape covered by large interior cells and small boundary cells">
          {SQUARES.map((s, i) => (
            <rect
              key={i}
              x={s.x}
              y={s.y}
              width={s.size}
              height={s.size}
              fill={color}
              fillOpacity={s.state === 'inside' ? 0.35 : 0.12}
              stroke={color}
              strokeWidth={0.6}
            />
          ))}
          <polygon points={OUTLINE} fill="none" stroke="currentColor" strokeWidth={1.5} />
        </svg>
        <div className="small">
          <p>
            The map is drawing a <strong>normalized covering</strong>. Wherever all of a cell's children would lie
            inside the polygon, they're merged into the parent cell. That repeats upward, so the interior collapses into a
            few large cells.
          </p>
          <p>
            Only cells the <strong>boundary</strong> passes through are split all the way down to level N, which is
            why the small cells trace the outline. (The lighter cells in the diagram are boundary cells, which are only
            partly inside.)
          </p>
          <p>
            The count is unchanged: a cell k levels coarser than N stands for every level‑N cell under it, which is{' '}
            {kinds.map((k, i) => (
              <span key={k}>
                {i > 0 && (i === kinds.length - 1 ? ' or ' : ', ')}
                <strong style={{ color: GRID_META[k].color }}>{CHILDREN[k]}</strong>
                <sup>k</sup> for {GRID_META[k].label}
              </span>
            ))}
            . This is also how an index would store the feature: far fewer IDs than one per level‑N cell, still exact,
            and each coarse ID matches its descendants by ID range (S2) or prefix (geohash).
          </p>
          {kinds.includes('h3') && (
            <p>
              H3 is only approximate here: a hexagon's 7 children don't tile it exactly, so compacted H3 outlines
              overlap the boundary slightly.
            </p>
          )}
          <p className="muted">
            Untick "Mixed levels" to draw every level‑N cell instead (when there are few enough to draw). S2 cells look
            like slanted parallelograms because they are cube-face cells drawn in Web Mercator.
          </p>
        </div>
      </div>
    </details>
  )
}
