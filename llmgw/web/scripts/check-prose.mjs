#!/usr/bin/env node
// 文字预算守卫：控制台页面**常驻可见**的解释性文字要有上限。
//
// 由来：用户 2026-07-29 反馈「组织与自助接入、预算与用量、系统运维偏教程、啰嗦，
// 熟人嫌烦、新人还是不会用」。实测下来，请求记录页（唯一排过版的基准页）只有
// 220 个汉字 / 1 段正文，而组织页 537 / 8 段、预算与用量 575 / 7 段。
//
// 关键设计：**只数常驻可见的文字**。收进四个出口的解释一律不计入预算——
//   出口一 HelpPopover   字段旁的 ?，点开才看
//   出口三 DetailsBlock  默认收起的「工作原理」
// 否则守卫会逼着人把有用的帮助内容删掉，那是把问题从「啰嗦」换成「什么都不说」。
// 空状态与教程外链本来就短，不单独豁免。
//
// 规则见 doc/rule.platform.llm-gateway.console-design-tonality.md 原则 7。
// 用法：pnpm check:prose
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

// 默认预算：基准页是 220 汉字 / 1 段；留出余量定在 400 / 2。
const DEFAULT_BUDGET = { maxParagraphs: 2, maxCjk: 400 };

// 一段 = 连续 ≥24 个汉字的文本。更短的是标签、按钮、chip，不是正文。
const PARAGRAPH_MIN_CJK = 24;

// 收纳解释的组件——区间内的文字不计入预算。
const OUTLET_COMPONENTS = ['HelpPopover', 'DetailsBlock'];

/**
 * 存量欠账（棘轮）。数值 = 2026-07-29 迁移组织页时的**实测值**，不是拍脑袋留的余量：
 * 已经超标的页面只许往下降，不许再涨；迁移完一页就删掉对应条目。
 * 参照系：基准页 components/LogsView.tsx 是 1 段 / 220 字，组织页迁移后 1 段 / 225 字。
 *
 * 加新条目**必须写理由**。理由要说清「为什么这些字现在还在页面上」，
 * 而不是「让 CI 过一下」。
 */
const BUDGETS = [
  { file: 'pages/QuickstartPage.tsx', maxParagraphs: 9, maxCjk: 607, allowPageCenter: true, reason: 'TODO 待迁移：四协议接入片段是产品内容，迁移时要拆出真正的解释性段落；居中 1080 同批去掉' },
  { file: 'pages/ModelPoolsPage.tsx', maxParagraphs: 8, maxCjk: 488, reason: 'TODO 待迁移：六种策略说明尚未收进出口' },
  { file: 'pages/LearningCenterPage.tsx', maxParagraphs: 5, maxCjk: 362, reason: 'TODO 待迁移：学习中心本身就是讲解页，迁移时需重新界定它的预算口径' },
  { file: 'pages/ServiceKeysPage.tsx', maxParagraphs: 4, maxCjk: 446, reason: 'TODO 待迁移：密钥作用域说明尚未收进出口' },
  { file: 'pages/ExchangesPage.tsx', maxParagraphs: 4, maxCjk: 417, reason: 'TODO 待迁移：空状态三步引导待收口；公网 WSS 与固定 IP 两句是教程锚点，必须逐字保留' },
  { file: 'pages/AppCallersPage.tsx', maxParagraphs: 3, maxCjk: 288, reason: 'TODO 待迁移' },
  { file: 'pages/OverviewPage.tsx', maxParagraphs: 3, maxCjk: 163, reason: 'TODO 待迁移：系统运维页的容器拓扑说明尚未收进折叠块' },
];

const CJK = /[㐀-䶿一-鿿]/g;
const countCjk = (text) => (text.match(CJK) || []).length;

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  return entry.isDirectory() ? walk(full) : [full];
});

/** 把区间替换成等长空白：保留换行，行号不错位。 */
const blank = (text) => text.replace(/[^\n]/g, ' ');

/**
 * 屏蔽出口组件区间。非贪婪配对即可——这些组件不会自嵌套。
 * 自闭合写法没有正文，不需要处理。
 */
function maskOutlets(source) {
  let out = source;
  for (const name of OUTLET_COMPONENTS) {
    out = out.replace(new RegExp(`<${name}[^]*?</${name}>`, 'g'), blank);
  }
  return out;
}

/** 屏蔽 {/* prose-ok: 理由 *\/} 之后紧邻的一段（同样必须写理由）。 */
function maskPragmas(source) {
  return source.replace(/\{\s*\/\*\s*prose-ok:[^*]*\*\/\s*\}\s*(<[^>]*>)?([^<]*)/g, (match) => blank(match));
}

const violations = [];
const warnings = [];

for (const full of walk(SRC)) {
  const rel = path.relative(SRC, full);
  if (!/^pages\//.test(rel) && rel !== 'components/LogsView.tsx') continue;
  if (!/\.tsx$/.test(rel)) continue;

  try {
    let source = fs.readFileSync(full, 'utf8');
    // 注释先走：注释里的中文不是界面文字。
    source = source.replace(/\/\*[^]*?\*\//g, blank).replace(/^[ \t]*\/\/.*$/gm, blank);
    source = maskPragmas(source);
    source = maskOutlets(source);

    // JSX 文本节点候选：`>...<` 之间的内容。
    // 只保留含汉字的 —— TS 泛型（Record<string, X>）和比较运算永远不含汉字，
    // 这一条过滤让「不引入 parser 依赖」的做法几乎零误报。
    const runs = [];
    for (const match of source.matchAll(/>([^<>{}]*)</g)) {
      const text = match[1];
      if (countCjk(text) > 0) runs.push(text);
    }

    const totalCjk = runs.reduce((sum, text) => sum + countCjk(text), 0);
    const paragraphs = runs.filter((text) => countCjk(text) >= PARAGRAPH_MIN_CJK);

    const override = BUDGETS.find((item) => rel === item.file);
    const budget = override ?? DEFAULT_BUDGET;

    if (paragraphs.length > budget.maxParagraphs) {
      violations.push(
        `${rel}  常驻正文 ${paragraphs.length} 段（上限 ${budget.maxParagraphs}）\n`
        + paragraphs.slice(0, 4).map((text) => `      · ${text.trim().slice(0, 42)}…`).join('\n'),
      );
    }
    if (totalCjk > budget.maxCjk) {
      violations.push(`${rel}  常驻文字 ${totalCjk} 个汉字（上限 ${budget.maxCjk}）`);
    }

    // 页面级居中已废止（原则 6）：贴边全宽 + 段落走 --measure、表单走 .lg-form-grid。
    const lines = budget.allowPageCenter ? [] : source.split('\n');
    lines.forEach((line, index) => {
      const hit = /maxWidth:\s*(\d{3,})/.exec(line);
      if (!hit || Number(hit[1]) < 900) return;
      const near = lines.slice(Math.max(0, index - 2), index + 3).join(' ');
      if (!/margin:\s*['"`]?0 auto/.test(near)) return;
      violations.push(`${rel}:${index + 1}  页面级 max-width 居中已废止  ← 容器贴边全宽，正文用 .lg-prose、表单用 .lg-form-grid 控制宽度`);
    });
  } catch (error) {
    // 这个守卫挡着 pnpm build，绝不能因为自己解析失败就把整条构建拦下来。
    warnings.push(`${rel}  解析跳过：${error.message}`);
  }
}

for (const warning of warnings) console.warn('文字预算守卫警告：' + warning);

if (violations.length) {
  console.error('文字预算守卫未通过：\n');
  for (const violation of violations) console.error('  ' + violation);
  console.error('\n把超出的解释挪进四个出口之一：');
  console.error('  1) 字段旁的 <HelpPopover>   2) 空状态   3) 默认收起的 <DetailsBlock>   4) <TutorialLink> 深链教程');
  console.error('确有理由超预算时，在 scripts/check-prose.mjs 的 BUDGETS 里登记并写明原因。');
  process.exit(1);
}

console.log(`文字预算守卫通过：常驻正文 ≤${DEFAULT_BUDGET.maxParagraphs} 段 / ≤${DEFAULT_BUDGET.maxCjk} 汉字（出口内的解释不计入）。`);
