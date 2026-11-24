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
 * --board 可给多次，格式 `id=中文名:目录` 或 `id=中文名:目录:主题`（主题缺省 dark）。
 *
 * 两种画布约定都支持：
 *   - 一块画板 + 主题切换 → 深浅两套放 `<目录>` 与 `<目录>-light`，脚本一起收；
 *   - 深浅各是**独立画板**（本仓库那份就是「01 主控台-深 / 01 主控台-浅」）→ 用第三段显式声明主题。
 * 不做「按标签名猜主题」：猜错了会把浅色档位记在 dark 键下，后面对 token 全是错的，
 * 而那份规格看上去完全正常。只在标签明显与声明冲突时**提醒**，判断权还在调用方。
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
  const rest = raw.slice(colon + 1);
  // 第三段是可选主题；目录名里可能带盘符/冒号，所以从右边找最后一个冒号再判它是不是主题词
  const lastColon = rest.lastIndexOf(':');
  const maybeTheme = lastColon > 0 ? rest.slice(lastColon + 1) : '';
  const hasTheme = maybeTheme === 'dark' || maybeTheme === 'light';
  const dir = hasTheme ? rest.slice(0, lastColon) : rest;
  const theme = hasTheme ? maybeTheme : 'dark';

  // 标签写着「浅」却按深色归档，多半是漏了第三段——这种错会让整屏档位对错 token，
  // 而导出文件本身长得完全正常，事后极难发现。
  const labelSaysLight = /浅|light/i.test(label);
  if (labelSaysLight && theme === 'dark') {
    console.warn(`[存疑] ${id} 标签是「${label}」，却按 dark 归档。要么补第三段 :light，要么确认标签名有误。`);
  }
  if (!labelSaysLight && /深|dark/i.test(label) && theme === 'light') {
    console.warn(`[存疑] ${id} 标签是「${label}」，却按 light 归档。`);
  }
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
      [theme]: scaleOf(dark.counts, minCount),
      // `<目录>-light` 那套只在「一块画板 + 主题切换」的约定下存在；
      // 深浅各自成板时不会有它，此处自然为空。
      ...(light && theme !== 'light' ? { light: scaleOf(light.counts, minCount) } : {}),
    },
    textCount: (dark.texts || []).length,
  });
  if (!light && theme === 'dark') {
    console.warn(`[提示] ${id} 只有深色档（没有 ${dir}-light，也没声明 :light）`);
  }
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
  const dims = Object.values(b.scales).reduce((n, sc) => Math.max(n, Object.keys(sc).length), 0);
  console.log(`  ${b.id} ${b.label}：${themes}，${dims} 个维度`);
}
}
