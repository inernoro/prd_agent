#!/usr/bin/env node
/**
 * 样例数据漂移守卫：拿真机再录一遍，只比**形状**（键路径），不比值。
 *
 * 要防的事故很具体：后端把 `items` 改成 `list`、或给响应多包一层，fixture 还是老形状。
 * 回放时应用解析不出东西，页面渲染成空——而覆盖率报告只会说「文案缺失 87 条」，
 * 你会以为是实现漏了文案，实际是样例数据早就喂不进去了。
 * （predicate-and-wiring-discipline 形状 4b：一个不会红的证据比没有证据更糟。）
 *
 * 判据分两类，严重度不同：
 *   **少键**（fixture 有、真机没有）→ 失败。这是 fixture 过期的确证：喂进去的字段应用可能
 *     已经不认了，且真机响应里对应的新字段 fixture 根本没有。
 *   **多键**（真机有、fixture 没有）→ 只提示。多半是这次录制的数据恰好带了可选字段
 *     （某条记录有 revokedReason、fixture 那条没有），不构成失效。
 *
 * 用法：
 *   node fixture-drift.mjs --dir <fixture 目录> --url <实现页地址> \
 *     [--storage <auth.json>] [--width 1600] [--wait 12000]
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installFixtures, keyShape } from './fixtures.mjs';

const { chromium } = createRequire(path.join(process.cwd(), 'noop.js'))('playwright');

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i < 0 ? d : process.argv[i + 1];
};
const dir = arg('--dir');
const url = arg('--url');
const storage = arg('--storage', null);
const width = Number(arg('--width', '1600'));
const wait = Number(arg('--wait', '12000'));
if (!dir || !url) {
  console.error('必填：--dir <fixture 目录> --url <实现页地址>');
  process.exit(2);
}
if (!fs.existsSync(dir)) {
  console.error(`fixture 目录不存在：${dir}`);
  process.exit(2);
}

const CHROME = process.env.CHROME_BIN
  || (fs.existsSync('/opt/pw-browsers')
    ? fs.readdirSync('/opt/pw-browsers').filter((d) => d.startsWith('chromium-'))
      .map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`).find((p) => fs.existsSync(p))
    : undefined);

const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-drift-'));
const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const ctx = await browser.newContext({
  viewport: { width, height: 1000 },
  storageState: storage && fs.existsSync(storage) ? storage : undefined,
});
const page = await ctx.newPage();
await installFixtures(page, { dir: fresh, mode: 'record' });
await page.goto(url, { waitUntil: 'load', timeout: 90000 });
await page.waitForTimeout(wait);
await browser.close();

const parse = (file) => {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    return JSON.parse(saved.body);
  } catch { return null; }
};

const stored = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
const recorded = new Set(fs.readdirSync(fresh).filter((f) => f.endsWith('.json')));

const rows = [];
let failed = 0;
let unchecked = 0;

for (const f of stored) {
  if (!recorded.has(f)) {
    // 这次没请求到同一个端点：可能是页面路径不同、也可能端点没了。
    // 不判失败（本次录制没覆盖到，不是证据），但要如实说没验到——
    // 「这次没测到」被读成「测过了没问题」，正是不会红的证据那一类。
    unchecked += 1;
    rows.push(`[未验] ${f} —— 本次访问没有请求这个端点`);
    continue;
  }
  const a = parse(path.join(dir, f));
  const b = parse(path.join(fresh, f));
  if (a === null || b === null) {
    rows.push(`[未验] ${f} —— 响应体不是 JSON，形状比对跳过`);
    unchecked += 1;
    continue;
  }
  const sa = keyShape(a);
  const sb = keyShape(b);
  const gone = [...sa].filter((k) => !sb.has(k));
  const added = [...sb].filter((k) => !sa.has(k));
  if (gone.length) {
    failed += 1;
    rows.push(`[失效] ${f}\n        fixture 有、真机已无：${gone.slice(0, 8).join(', ')}${gone.length > 8 ? ` …共 ${gone.length} 个` : ''}`);
  } else if (added.length) {
    rows.push(`[提示] ${f} —— 真机多出 ${added.length} 个键（多半是可选字段，不影响回放）`);
  } else {
    rows.push(`[一致] ${f}`);
  }
}

console.log(rows.join('\n'));
console.log(`\n共 ${stored.length} 份 fixture：失效 ${failed}，未验 ${unchecked}，其余形状一致。`);
fs.rmSync(fresh, { recursive: true, force: true });

if (failed) {
  console.error('\n有 fixture 的形状已经跟真机对不上了。回放时应用解析不出内容，页面会渲染成空，');
  console.error('而覆盖率只会报「文案缺失」——先用 --record-fixtures 重录，再把里面的值改回设计稿那套。');
  process.exit(1);
}
