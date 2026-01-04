import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const SRC = path.join(ROOT, 'src');

const PATTERNS = [
  { name: 'text-white', re: /\btext-white\b|text-white\/\d+/g },
  { name: 'border-white', re: /\bborder-white\b|border-white\/\d+/g },
  { name: 'bg-slate-9xx', re: /\bbg-slate-9\d\d\b/g },
  { name: 'from|via|to-slate-9xx', re: /\b(from|via|to)-slate-9\d\d\b/g },
];

const EXT_ALLOW = new Set(['.ts', '.tsx', '.css']);
const IGNORE_DIR = new Set(['node_modules', 'dist', 'src-tauri', '.git']);

function walk(dir) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (IGNORE_DIR.has(ent.name)) continue;
      out.push(...walk(abs));
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name);
      if (EXT_ALLOW.has(ext)) out.push(abs);
    }
  }
  return out;
}

function rel(p) {
  return path.relative(ROOT, p).replaceAll('\\', '/');
}

function scanFile(file) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split(/\r?\n/);
  const hits = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    // allow explicit ignore: theme-scan-ignore
    if (line.includes('theme-scan-ignore')) continue;

    for (const p of PATTERNS) {
      const m = line.match(p.re);
      if (m && m.length) {
        hits.push({ pattern: p.name, lineNo: i + 1, line: line.trim() });
      }
    }
  }
  return hits;
}

const strict = process.env.THEME_SCAN_STRICT === '1';
let total = 0;
let files = 0;

for (const f of walk(SRC)) {
  const hits = scanFile(f);
  if (!hits.length) continue;
  files += 1;
  total += hits.length;
  // eslint-disable-next-line no-console
  console.log(`\n${rel(f)} (${hits.length})`);
  for (const h of hits.slice(0, 50)) {
    // eslint-disable-next-line no-console
    console.log(`  L${h.lineNo} [${h.pattern}] ${h.line}`);
  }
  if (hits.length > 50) {
    // eslint-disable-next-line no-console
    console.log(`  ... +${hits.length - 50} more`);
  }
}

// eslint-disable-next-line no-console
console.log(`\nTheme scan done. suspiciousMatches=${total}, files=${files}, strict=${strict}`);

if (strict && total > 0) {
  process.exitCode = 1;
}


