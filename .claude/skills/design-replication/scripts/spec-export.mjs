#!/usr/bin/env node
/**
 * 把量出来的档位表固化成**仓库里的一份机器可读规格**。
 *
 * 为什么需要：extract-spec 的产物落在 scratchpad 里，会话一结束就没了。于是每次想回答
 * 「这一屏的圆角到底有几档」「设计稿改版之后哪几档变了」都得把整条取证重跑一遍——
 * 而重跑要有画布文件、要起服务、要装浏览器，多数时候没人跑，最后又退回「凭印象说」。
 * 固化之后，规格是仓库里可 diff 的一份事实，改版只需再导一次然后看 diff。
 *
 * 它不是文档：doc/ 那边写「为什么这么设计」，这里存「量出来是多少」。两者不能互相替代——
 * 文档会漂移，这份不会，因为它是机器写的、且带着来源指纹。
 *
 * **带指纹**（no-rootless-tree）：记下画布文件的 sha256 与量取时间。一份说不清
 * 「从哪个稿子、什么时候量的」的规格，下次没人敢信，等于又要重跑。
 *
 * 用法：
 *   node spec-export.mjs --design web-hosting-v2 \
 *     --source <画布文件路径> \
 *     --board board-01=屏1主控台:<spec 目录> \
 *     --board board-02=屏2站点卡:<spec 目录> \
 *     [--out <导出目录>] [--min-count 2]
 *
 * --board 可给多次，格式 `id=中文名:目录`。目录下要有 extract-spec 产出的 spec.json；
 * 同一个 board 的深浅两套分别放在 `<目录>` 与 `<目录>-light`（有就一起收）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

/**
 * 只保留出现次数达标的档位，并丢掉每档的 sample。
 *
 * sample 是「这个值是谁用的」的定位线索，跨次导出并不稳定（元素一多一少就变），
 * 留在导出里会让 diff 全是噪音——而 diff 一旦噪音多，人就不看了。
 */
export function scaleOf(counts, minCount = 2) {
  const out = {};
  for (const [dim, rows] of Object.entries(counts || {})) {
    const kept = (rows || [])
      .filter((r) => r.count >= minCount)
      .map((r) => ({ value: r.value, count: r.count }));
    if (kept.length) out[dim] = kept;
  }
  return out;
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i < 0 ? d : process.argv[i + 1];
};
const argAll = (n) => {
  const out = [];
  process.argv.forEach((a, i) => { if (a === n) out.push(process.argv[i + 1]); });
  return out;
};

const design = arg('--design');
const source = arg('--source');
const boardArgs = argAll('--board');
const minCount = Number(arg('--min-count', '2'));
const outDir = arg('--out', path.join('.claude/skills/design-replication/exports', design || 'unnamed'));

if (!design || !source || boardArgs.length === 0) {
  console.error('必填：--design <名字> --source <画布文件> --board <id=名字:spec目录>（可多次）');
  process.exit(2);
}
if (!fs.existsSync(source)) {
  console.error(`画布文件不存在：${source}。规格必须能说清是从哪个稿子量的，没有来源就不导。`);
  process.exit(2);
}

function readSpec(dir) {
  const f = path.join(dir, 'spec.json');
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

const boards = [];
for (const raw of boardArgs) {
  const eq = raw.indexOf('=');
  const colon = raw.indexOf(':', eq + 1);
  if (eq < 0 || colon < 0) {
    console.error(`--board 格式应为 id=名字:目录，收到：${raw}`);
    process.exit(2);
  }
  const id = raw.slice(0, eq);
  const label = raw.slice(eq + 1, colon);
  const dir = raw.slice(colon + 1);
  const dark = readSpec(dir);
  if (!dark) {
    console.error(`${id}：${dir}/spec.json 不存在。缺一屏就导，导出来的规格是残的，比没有更误导。`);
    process.exit(3);
  }
  const light = readSpec(`${dir}-light`);
  boards.push({
    id,
    label,
    // 量的是哪一段（extract-spec 的取范围），存下来才知道这份档位覆盖的是哪一屏
    range: { yFrom: dark.yFrom ?? null, yTo: dark.yTo === Number.MAX_SAFE_INTEGER ? null : dark.yTo ?? null, scope: dark.scope ?? null },
    elements: dark.elements ?? null,
    scales: {
      dark: scaleOf(dark.counts, minCount),
      ...(light ? { light: scaleOf(light.counts, minCount) } : {}),
    },
    textCount: (dark.texts || []).length,
  });
  if (!light) console.warn(`[提示] ${id} 没有浅色那一份（${dir}-light），这份规格只覆盖深色档`);
}

const sha = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
const skillVersion = (() => {
  try {
    const sk = fs.readFileSync('.claude/skills/design-replication/SKILL.md', 'utf8');
    return sk.match(/^version:\s*(.+)$/m)?.[1]?.trim() ?? null;
  } catch { return null; }
})();

const doc = {
  design,
  source: { file: path.basename(source), sha256: sha, bytes: fs.statSync(source).size },
  tool: { script: 'spec-export.mjs', skillVersion },
  extractedAt: new Date().toISOString(),
  minCount,
  boards,
};

fs.mkdirSync(outDir, { recursive: true });
const jsonPath = path.join(outDir, 'design-spec.json');
fs.writeFileSync(jsonPath, `${JSON.stringify(doc, null, 2)}\n`);

// 人读的那一份：每屏一节，每个维度一行档位（按频次降序，只列前若干档）
const md = [
  `# ${design} 设计档位表`,
  '',
  `> 机器导出，勿手改。来源 \`${doc.source.file}\`（sha256 \`${sha.slice(0, 12)}…\`），`
  + `量于 ${doc.extractedAt}，只收出现 ≥${minCount} 次的档位。`,
  '',
];
for (const b of boards) {
  md.push(`## ${b.id} · ${b.label}`, '');
  for (const [theme, scales] of Object.entries(b.scales)) {
    md.push(`### ${theme === 'light' ? '浅色' : '深色'}`, '');
    md.push('| 维度 | 档位（按出现次数降序） |', '|---|---|');
    for (const [dim, rows] of Object.entries(scales)) {
      const shown = rows.slice(0, 12).map((r) => `\`${r.value}\`×${r.count}`).join(' · ');
      md.push(`| ${dim} | ${shown}${rows.length > 12 ? ` …共 ${rows.length} 档` : ''} |`);
    }
    md.push('');
  }
}
fs.writeFileSync(path.join(outDir, 'design-spec.md'), `${md.join('\n')}\n`);

console.log(`导出 ${boards.length} 屏 → ${jsonPath}`);
for (const b of boards) {
  const themes = Object.keys(b.scales).join(' + ');
  const dims = Object.keys(b.scales.dark).length;
  console.log(`  ${b.id} ${b.label}：${themes}，${dims} 个维度`);
}
}
