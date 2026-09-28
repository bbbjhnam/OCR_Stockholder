export function upsertById<T extends { id: string }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index < 0) return [...items, next];
  const updated = [...items];
  updated[index] = next;
  return updated;
}

export function encodeCsv(rows: Array<Array<unknown>>): string {
  return "\ufeff" + rows
    .map((row) => row.map((cell) => {
      const raw = String(cell ?? "");
      const safe = typeof cell === "string" && /^\s*[=+\-@]/.test(raw) ? `'${raw}` : raw;
      return `"${safe.replace(/"/g, '""')}"`;
    }).join(","))
    .join("\r\n");
}
