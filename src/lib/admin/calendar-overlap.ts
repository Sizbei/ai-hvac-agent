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
  const order = spans
    .map((span, index) => ({ span, index }))
    .sort((a, b) => a.span.top - b.span.top || b.span.bottom - a.span.bottom);
  const slots: CardSlot[] = new Array(spans.length);
  let cluster: { index: number; column: number }[] = [];
  let columnEnds: number[] = [];
  let clusterBottom = -Infinity;

  const flush = () => {
    for (const c of cluster) slots[c.index] = { column: c.column, columns: columnEnds.length };
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
