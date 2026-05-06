#!/usr/bin/env node
/**
 * build-dist-esbuild.mjs — 用 esbuild 替代 `tsc --outDir` 做 emit。
 *
 * 用户反馈 2026-05-06:self-update 慢,tsc 编译 cds/dist 占 30-50s。
 * esbuild 同等转译只要 ~2s(纯 syntax 转换,不做类型检查)。
 *
 * **类型检查由并行的 `tsc --noEmit` 兜底**(不在本脚本范围内,在 self-update
 * 流程里 esbuild + tsc --noEmit 并行跑;两者都过才算 build 成功)。
 *
 * 用法:OUT_DIR=dist.next node scripts/build-dist-esbuild.mjs
 *
 * 设计取舍:
 * - bundle: false  纯 1:1 转译,保留模块边界,生成的 dist/ 跟 tsc emit 形状一致
 * - format: esm    匹配 cds/package.json 的 type: "module"
 * - target: node20 匹配 engines.node >=20
 * - outbase: src   保留 src/ 下的子目录结构(否则全平铺)
 *
 * 注意:本脚本同步实现,失败 process.exit(1)。调用方 (self-force-sync)
 * 检查退出码区分成功/失败。
 */

import { build } from 'esbuild';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cdsRoot = path.resolve(__dirname, '..');
const srcDir = path.join(cdsRoot, 'src');
const outDir = process.env.OUT_DIR
  ? path.resolve(cdsRoot, process.env.OUT_DIR)
  : path.join(cdsRoot, 'dist');

async function findTsFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await findTsFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const startedAt = Date.now();
const entries = await findTsFiles(srcDir);
console.log(`[build-dist-esbuild] 编译 ${entries.length} 个 .ts 文件 → ${path.relative(cdsRoot, outDir)}`);

await build({
  entryPoints: entries,
  outdir: outDir,
  outbase: srcDir,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  bundle: false,
  sourcemap: false,
  // tsc emit 一致的行为:source TS 已经在 import 语句写了 .js 后缀
  // (ESM module resolution 要求),esbuild 保持原样不动
  logLevel: 'info',
});

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
console.log(`[build-dist-esbuild] 完成,耗时 ${elapsed}s`);
