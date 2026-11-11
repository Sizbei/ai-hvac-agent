/**
 * Side-by-side layout for calendar cards that overlap in time (round-2 P1-1:
 * a double-booking stacked one card exactly on top of the other). Cards that
 * overlap, directly or through a chain, form a cluster; each card takes the
 * first column free at its top, and every card in the cluster shares the
 * cluster's column count, so widths line up. Pure: spans in, slots out, in
 * the input order.
 */
export interface CardSpan {
  readonly top: number;
  readonly bottom: number;
}

export interface CardSlot {
  /** 0-based column inside the cluster. */
  readonly column: number;
  /** Columns the cluster needs; 1 = the card has the lane to itself. */
  readonly columns: number;
}

export function overlapColumns(spans: readonly CardSpan[]): readonly CardSlot[] {
  return clusteredColumns(spans).map(({ column, columns }) => ({ column, columns }));
}

/** overlapColumns plus the id of the cluster each card belongs to. */
function clusteredColumns(
  spans: readonly CardSpan[],
): readonly (CardSlot & { readonly cluster: number })[] {
  const order = spans
    .map((span, index) => ({ span, index }))
    .sort((a, b) => a.span.top - b.span.top || b.span.bottom - a.span.bottom);
  const slots: (CardSlot & { cluster: number })[] = new Array(spans.length);
  let clusterId = -1;
  let cluster: { index: number; column: number }[] = [];
  let columnEnds: number[] = [];
  let clusterBottom = -Infinity;

  const flush = () => {
    if (cluster.length > 0) clusterId += 1;
    for (const c of cluster) {
      slots[c.index] = { column: c.column, columns: columnEnds.length, cluster: clusterId };
    }
    cluster = [];
    columnEnds = [];
  };

  for (const { span, index } of order) {
    if (span.top >= clusterBottom) flush();
    let column = columnEnds.findIndex((end) => end <= span.top);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(span.bottom);
    } else {
      columnEnds[column] = span.bottom;
    }
    cluster.push({ index, column });
    clusterBottom = cluster.length === 1 ? span.bottom : Math.max(clusterBottom, span.bottom);
  }
  flush();
  return slots;
}

/** A "+N more" bar standing in for the cards a crowded cluster can't fit. */
export interface OverflowTile {
  /** Full lane width, at the bottom of the cluster. */
  readonly top: number;
  readonly bottom: number;
  /** Cards hidden behind the bar. */
  readonly count: number;
}

export interface CappedSlot extends CardSlot {
  /** True when the card is folded into its cluster's overflow bar. */
  readonly hidden: boolean;
  /** Set when a shown card is shortened to end above the bar. */
  readonly bottom?: number;
}

/**
 * overlapColumns with a cap, for lanes too narrow for side-by-side cards (the
 * week grid: in a ~100px day, three or more overlapping requests became
 * slivers reading "8 …"). A cluster that fits in `maxColumns` is unchanged. A
 * wider one shows its first column of cards at full width and one bar
 * counting every card it hides: right under the shown cards, or along the
 * cluster's bottom edge when they reach it (a shown card that would run under
 * the bar then ends `gapPx` above it). Pure: spans in, slots (input order)
 * and bars out.
 */
export function cappedOverlapColumns(
  spans: readonly CardSpan[],
  maxColumns: number,
  barPx: number,
  gapPx = 2,
): { readonly slots: readonly CappedSlot[]; readonly overflow: readonly OverflowTile[] } {
  const raw = clusteredColumns(spans);
  const crowded = new Map<number, { top: number; bottom: number; shownBottom: number; count: number }>();
  raw.forEach((slot, i) => {
    if (slot.columns <= maxColumns) return;
    const span = spans[i]!;
    const c = crowded.get(slot.cluster) ?? { top: span.top, bottom: span.bottom, shownBottom: span.top, count: 0 };
    crowded.set(slot.cluster, {
      top: Math.min(c.top, span.top),
      bottom: Math.max(c.bottom, span.bottom),
      shownBottom: slot.column === 0 ? Math.max(c.shownBottom, span.bottom) : c.shownBottom,
      count: c.count + (slot.column > 0 ? 1 : 0),
    });
  });
  const barTop = (cluster: number) => {
    const c = crowded.get(cluster)!;
    return Math.max(c.top, Math.min(c.bottom - barPx, c.shownBottom + gapPx));
  };
  const slots = raw.map((slot, i): CappedSlot => {
    if (!crowded.has(slot.cluster)) return { column: slot.column, columns: slot.columns, hidden: false };
    if (slot.column > 0) return { column: 0, columns: 1, hidden: true };
    const limit = barTop(slot.cluster) - gapPx;
    const span = spans[i]!;
    return span.bottom > limit
      ? { column: 0, columns: 1, hidden: false, bottom: Math.max(limit, span.top) }
      : { column: 0, columns: 1, hidden: false };
  });
  const overflow = [...crowded.entries()].map(([cluster, c]) => ({
    top: barTop(cluster),
    bottom: barTop(cluster) + Math.min(barPx, c.bottom - c.top),
    count: c.count,
  }));
  return { slots, overflow };
}
