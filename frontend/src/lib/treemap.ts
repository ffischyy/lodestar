export interface Rect { x: number; y: number; w: number; h: number }
export interface Tile<T> extends Rect { item: T }

/** Squarified treemap (Bruls et al.): lays items into `box` with areas proportional to `value`, keeping tiles close to square. */
export function treemap<T>(items: T[], value: (t: T) => number, box: Rect): Tile<T>[] {
  const total = items.reduce((s, i) => s + Math.max(value(i), 0), 0);
  if (!total || box.w <= 0 || box.h <= 0) return [];
  const scale = (box.w * box.h) / total;
  const queue = items.map((item) => ({ item, area: Math.max(value(item), 0) * scale })).filter((x) => x.area > 0).sort((a, b) => b.area - a.area);
  const out: Tile<T>[] = [];
  let { x, y, w, h } = box;

  const worst = (row: number[], side: number) => {
    const s = row.reduce((a, b) => a + b, 0);
    return Math.max(...row.map((a) => Math.max((side * side * a) / (s * s), (s * s) / (side * side * a))));
  };

  while (queue.length) {
    const side = Math.min(w, h);
    const row = [queue[0]];
    let i = 1;
    while (i < queue.length && worst([...row, queue[i]].map((r) => r.area), side) <= worst(row.map((r) => r.area), side)) row.push(queue[i++]);
    queue.splice(0, row.length);
    const area = row.reduce((s, r) => s + r.area, 0);
    const thick = area / side;
    let along = 0;
    for (const r of row) {
      const len = r.area / thick;
      out.push(w >= h ? { item: r.item, x, y: y + along, w: thick, h: len } : { item: r.item, x: x + along, y, w: len, h: thick });
      along += len;
    }
    if (w >= h) { x += thick; w -= thick; } else { y += thick; h -= thick; }
  }
  return out;
}
