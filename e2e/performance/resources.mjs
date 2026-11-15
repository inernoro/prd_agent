import fs from 'node:fs/promises';

export function parseStat(text) {
  const split = text.lastIndexOf(')');
  const pid = Number(text.slice(0, text.indexOf(' ')));
  const fields = text.slice(split + 2).trim().split(/\s+/);
  return { pid, parent: Number(fields[1]), ticks: Number(fields[11]) + Number(fields[12]),
    rssPages: Number(fields[21]) };
}
export function processTree(table, root) {
  const descendants = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of table) if (descendants.has(p.parent) && !descendants.has(p.pid)) {
      descendants.add(p.pid); changed = true;
    }
  }
  const rows = table.filter(p => descendants.has(p.pid));
  return { ticks: rows.reduce((n, p) => n + p.ticks, 0), rssPages: rows.reduce((n, p) => n + p.rssPages, 0), pids: rows.map(p => p.pid) };
}
export async function readProcesses() {
  const entries = (await fs.readdir('/proc')).filter(name => /^\d+$/.test(name));
  const rows = await Promise.all(entries.map(async name => {
    try { return parseStat(await fs.readFile(`/proc/${name}/stat`, 'utf8')); }
    catch { return null; } // A process may exit between readdir and read.
  }));
  return rows.filter(Boolean);
}
