#!/usr/bin/env node
// 从 CHANGELOG.md 抽取最近 1 个月 prd-desktop 模块的更新条目，输出为 JSON
// 供桌面端更新通知面板读取（public/recent-updates.json）。
//
// 运行：node scripts/build-recent-updates.mjs
// 产物：prd-desktop/public/recent-updates.json

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

const CHANGELOG = join(ROOT, 'CHANGELOG.md');
const OUT_DIR = join(ROOT, 'prd-desktop', 'public');
const OUT_FILE = join(OUT_DIR, 'recent-updates.json');

const MODULE_FILTER = new Set(['prd-desktop']);
const WINDOW_DAYS = 30;
const MIN_ENTRIES = 3; // 至少保留 3 条

function parseDate(line) {
  const m = line.match(/^###\s+(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const ts = Date.parse(iso + 'T00:00:00Z');
  if (Number.isNaN(ts)) return null;
  return { iso, ts };
}

function parseRow(line) {
  // 格式：| 类型 | 模块 | 描述 |
  const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|\s*$/);
  if (!m) return null;
  const [, type, mod, desc] = m;
  if (!type || !mod || !desc) return null;
  // 过滤表头分隔行 "|---|---|---|"
  if (/^-+$/.test(type) || /^-+$/.test(mod)) return null;
  return { type: type.trim(), module: mod.trim(), description: desc.trim() };
}

function main() {
  if (!existsSync(CHANGELOG)) {
    console.error('CHANGELOG.md not found at', CHANGELOG);
    process.exit(1);
  }
  const text = readFileSync(CHANGELOG, 'utf8');
  const lines = text.split(/\r?\n/);

  const cutoff = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;

  /** @type {Array<{date: string, type: string, module: string, description: string}>} */
  const collected = [];
  /** 未经日期过滤的全量（兜底使用） */
  const all = [];

  let currentDate = null;
  for (const line of lines) {
    const d = parseDate(line);
    if (d) {
      currentDate = d;
      continue;
    }
    if (!currentDate) continue;
    const row = parseRow(line);
    if (!row) continue;
    if (!MODULE_FILTER.has(row.module.toLowerCase())) continue;
    const entry = { date: currentDate.iso, ts: currentDate.ts, ...row };
    all.push(entry);
    if (currentDate.ts >= cutoff) collected.push(entry);
  }

  // 若最近窗口不足 MIN_ENTRIES，回退取全量里最新的 MIN_ENTRIES 条
  let final = collected;
  if (final.length < MIN_ENTRIES && all.length >= MIN_ENTRIES) {
    all.sort((a, b) => b.ts - a.ts);
    final = all.slice(0, MIN_ENTRIES);
  }

  // 按日期倒序 + 去 ts 字段
  final.sort((a, b) => b.ts - a.ts);
  const payload = {
    generatedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    items: final.map(({ date, type, module, description }) => ({ date, type, module, description })),
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`[recent-updates] wrote ${payload.items.length} entries → ${OUT_FILE}`);
}

main();
