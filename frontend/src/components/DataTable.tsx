import clsx from "clsx";
import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  sort?: (row: T) => number | string | null | undefined;
  num?: boolean;
  sticky?: boolean;
  width?: number | string;
  title?: string;
}

/** Sortable, keyboard-navigable table. Numbers right-aligned in tabular figures; first column can be pinned. */
export function DataTable<T>({ rows, columns, rowKey, onRowClick, onRowContext, initialSort, maxHeight, empty, selectedKey, label }: {
  rows: T[]; columns: Column<T>[]; rowKey: (r: T) => string | number; onRowClick?: (r: T) => void;
  onRowContext?: (r: T, e: React.MouseEvent) => void; initialSort?: { key: string; desc?: boolean }; maxHeight?: number | string;
  empty?: ReactNode; selectedKey?: string | number | null; label: string;
}) {
  const [sort, setSort] = useState(initialSort ?? null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sort) return rows;
    const get = col.sort;
    return [...rows].sort((a, b) => {
      const va = get(a), vb = get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const r = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
      return sort.desc ? -r : r;
    });
  }, [rows, columns, sort]);

  const toggle = (k: string) =>
    setSort((s) => (s?.key === k ? (s.desc ? { key: k, desc: false } : null) : { key: k, desc: true }));

  const onKey = (e: React.KeyboardEvent<HTMLTableRowElement>, r: T) => {
    if (e.key === "Enter" && onRowClick) onRowClick(r);
    if (e.key === "ArrowDown") (e.currentTarget.nextElementSibling as HTMLElement | null)?.focus();
    if (e.key === "ArrowUp") (e.currentTarget.previousElementSibling as HTMLElement | null)?.focus();
    if ((e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && onRowContext) {
      const rect = e.currentTarget.getBoundingClientRect();
      onRowContext(r, { clientX: rect.left + 40, clientY: rect.bottom, preventDefault: () => {} } as React.MouseEvent);
      e.preventDefault();
    }
  };

  if (!rows.length && empty) return <>{empty}</>;
  return (
    <div className="table-wrap" style={{ maxHeight }}>
      <table className="dt" aria-label={label}>
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th key={c.key} className={clsx(c.num && "num", c.sort && "sortable", c.sticky && "sticky")} style={{ width: c.width }}
                  title={c.title} aria-sort={active ? (sort!.desc ? "descending" : "ascending") : undefined}
                  onClick={c.sort ? () => toggle(c.key) : undefined}
                  onKeyDown={c.sort ? (e) => (e.key === "Enter" || e.key === " ") && (toggle(c.key), e.preventDefault()) : undefined}
                  tabIndex={c.sort ? 0 : undefined}>
                  {c.header}
                  {c.sort && (
                    <span className="sort" aria-hidden>
                      {active ? (sort!.desc ? <ChevronDown size={12} /> : <ChevronUp size={12} />) : <ChevronsUpDown size={11} opacity={0.45} />}
                    </span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const k = rowKey(r);
            return (
              <tr key={k} className={clsx(onRowClick && "clickable", selectedKey === k && "selected")} tabIndex={onRowClick ? 0 : undefined}
                onClick={onRowClick ? () => onRowClick(r) : undefined} onKeyDown={(e) => onKey(e, r)}
                onContextMenu={onRowContext ? (e) => { e.preventDefault(); onRowContext(r, e); } : undefined}>
                {columns.map((c) => (
                  <td key={c.key} className={clsx(c.num && "num", c.sticky && "sticky")}>{c.cell(r)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
