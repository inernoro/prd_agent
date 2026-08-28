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
// 已知边界（不要当成"已经很干净"）：守卫看得见「文字写在哪」，看不见「常量最终渲染到哪个出口」。
// 一个定义在文件顶部、实际只喂给 HelpPopover 的说明常量，仍会被计入常驻预算。
// 这类页面在 BUDGETS 里按实测值封顶并写明理由；真要精确，得引入 parser 做数据流分析。
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

// 确认弹窗的文案同理不是常驻文字：只有点了破坏性操作才会看到它，
// 和 HelpPopover「点了才看」是同一类。2026-08-11 把原生 window.confirm/prompt
// 换成站内弹窗后，这些 title/description 被当成正文数进了预算，属于误报。
const OUTLET_CALLS = ['confirm', 'promptText'];

/**
 * 存量欠账（棘轮）。数值 = 2026-07-29 迁移组织页时的**实测值**，不是拍脑袋留的余量：
 * 已经超标的页面只许往下降，不许再涨；迁移完一页就删掉对应条目。
 * 参照系：基准页 components/LogsView.tsx 是 1 段 / 220 字，组织页迁移后 1 段 / 225 字。
 *
 * 加新条目**必须写理由**。理由要说清「为什么这些字现在还在页面上」，
 * 而不是「让 CI 过一下」。
 */
const BUDGETS = [
  // 本轮范围外的页面（用户点名的 10 页不含它们），按当前实测值封顶，只减不增。
  // 数值偏大是因为 2026-07-29 加宽了口径：此前只数 `>文本<`，把正文搬进常量数组即可绕过，
  // 学习中心旧版就是靠 TOPICS 数组藏了约 750 汉字。加宽后这些页面的真实文字量才显形。
  { file: 'pages/AppCallersPage.tsx', maxParagraphs: 3, maxCjk: 303, reason: '本轮范围外，按加宽口径后的实测值封顶；2026-08-10 +4 是两处「删除」按钮文案（桌面行与移动卡各一），按钮标签属控件可供性不是正文，但守卫的 `>文本<` 口径分辨不出，只能计入' },
  { file: 'pages/PlatformsPage.tsx', maxParagraphs: 3, maxCjk: 300, reason: '本轮范围外，按加宽口径后的实测值封顶' },
  // Exchange 已迁移，常驻 JSX 正文为 0 段；超出的字来自 transformerType 等选项常量，
  // 它们实际渲染在 HelpPopover 里，但守卫看不出常量最终落到哪个出口（已知边界）。
  { file: 'pages/ExchangesPage.tsx', maxParagraphs: 2, maxCjk: 421, reason: '选项常量渲染在 HelpPopover 内，守卫无法识别常量的渲染位置；2026-08-10 +1 是新增的「删除」按钮文案（与图标同段，只多算一个汉字）' },
  { file: 'pages/ModelPoolsPage.tsx', maxParagraphs: 4, maxCjk: 582, reason: '2026-08-18 信息架构改版后重新登记。四段里只有副标题对所有人常驻，其余三段都有条件：补齐面板的写操作警告只在展开确认面板时出现、ReadOnlyNotice 只对只读角色出现、六种策略说明是常量（渲染在 HelpPopover 与新建向导的策略卡里）。汉字数上升的主体是**诊断信息本身**——池状态结论句、第1顺位连续失败与最近失败/成功时间、指标的窗口标签，它们是后端早就返回、此前一个都没显示的字段，正是这次改版要露出来的东西，收进折叠块就等于没改。守卫按 `>文本<` 计数，分不出「常驻说明」与「按数据渲染的结论」，这里如实登记而不是把结论藏起来凑数。2026-08-18 二次上调 558→582：与设计稿并排比对后，新建向导的两条字段说明改为逐字照抄设计稿（「类型决定这个池能承接哪些调用，创建后不可改。」「会显示在池详情标题下和列表悬浮提示里。」）。它们只在新建流程里出现、且正是出口 1「字段旁的说明」所鼓励的形态，但守卫按 hint= 属性计数，识别不出条件渲染。同批还删掉了两个 HelpPopover 里逐字重复的「补齐」语义与一条自己编的提示，净增只有这两句' },
  { file: 'pages/QuickstartPage.tsx', maxParagraphs: 1, maxCjk: 460, reason: '接入片段常量属产品内容（用户复制走的东西），不是页面解释。2026-08-27 二次改版 356→454：**上调的 98 字全部是新增的 systemPromptSnippet**——那是一段可直接粘进用户自己应用的系统提示词，与四协议 cURL/Agent Skill 片段同类，是产品交付物；它渲染在产物屏「提示词」页签的代码块里，不是常驻解释。同批把页面自己的解释继续压了：三档取用方式的说明各压到一句、第一屏副标题去掉半句、接入地址卡的注脚减半，常驻段落数仍是 1（主按钮旁那句密钥默认值说明）。守卫按常量字面量计数、看不出常量最终落到哪个出口，因此按实测值封顶登记；下次若删掉系统提示词或把它挪进 DetailsBlock，这个值要跟着降回去。2026-08-28 三次上调 454→459：**上调的 5 字全部是字段标签，不是解释**——试跑区改成「上输入 / 下输出」后新增「要发什么」「模型返回」两个字段标签，并把「请求片段」的复制按钮收进标题行（该行的结构变化让原本被 `{}` 打断、守卫数不到的「请求片段」标签也进了计数）。三者都是控件可供性（同 AppCallersPage 条目里「删除」按钮的情形），守卫的 `>文本<` 口径分辨不出标签与正文。同批**没有**新增任何解释句：新写的空态与计费提示都跟在 `{}` 表达式后、本来就不计数，计费提示按设计稿逐字回抄（复刻并排比对时发现实现把它压短了，属文案偏差）。459→460 的那 1 个字，是标签「要发什么」按设计稿改回「你要发什么」' },
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

/**
 * 屏蔽确认弹窗调用的参数对象。
 * 必须数括号配对而不是用非贪婪正则：文案里带模板插值
 * （`${p.apiUrl || '无地址'}`），里面就有右花括号，正则会提前收口。
 */
function maskDialogCalls(source) {
  const chars = source.split('');
  for (const name of OUTLET_CALLS) {
    const opener = new RegExp(`\\b${name}\\(\\{`, 'g');
    let match;
    const text = chars.join('');
    while ((match = opener.exec(text)) !== null) {
      let depth = 0;
      let i = match.index + match[0].length - 1;
      for (; i < chars.length; i += 1) {
        if (chars[i] === '{') depth += 1;
        else if (chars[i] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      for (let k = match.index; k <= Math.min(i, chars.length - 1); k += 1) {
        if (chars[k] !== '\n') chars[k] = ' ';
      }
    }
  }
  return chars.join('');
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
    // 顺序要紧：pragma 必须在剥注释**之前**处理。
    // 之前写反了——`{/* prose-ok: … */}` 里的注释先被剥成空白，pragma 正则再也匹配不到，
    // 于是这个逃生门从来没生效过（一个不会生效的逃生门比没有更糟：它让人以为有退路）。
    source = maskPragmas(source);
    // 注释里的中文不是界面文字。
    source = source.replace(/\/\*[^]*?\*\//g, blank).replace(/^[ \t]*\/\/.*$/gm, blank);
    source = maskOutlets(source);
    source = maskDialogCalls(source);

    // JSX 文本节点候选：`>...<` 之间的内容。
    // 只保留含汉字的 —— TS 泛型（Record<string, X>）和比较运算永远不含汉字，
    // 这一条过滤让「不引入 parser 依赖」的做法几乎零误报。
    const runs = [];
    for (const match of source.matchAll(/>([^<>{}]*)</g)) {
      const text = match[1];
      if (countCjk(text) > 0) runs.push(text);
    }

    // 只数 `>文本<` 会留下一个大洞：**把正文搬进常量数组就能绕过预算**。
    // 实例：学习中心旧版把约 750 汉字、10 段解释放在 TOPICS 数组的
    // detail/summary 字段里，守卫一个字都没数到，却照样一屏铺满解释。
    // 所以承载正文语义的字段（写成 `x: '…'` 或 `x="…"` 都算）一并计入。
    // 刻意不含 title / label / placeholder / aria-* —— 那些是控件可供性不是正文，
    // 把它们计入会逼着人把输入框的标签删掉。
    const PROSE_FIELDS = /\b(?:detail|description|desc|summary|explanation|note|hint|body|subtitle)\s*[:=]\s*(['"`])((?:(?!\1)[^\\])*)\1/g;
    for (const match of source.matchAll(PROSE_FIELDS)) {
      const text = match[2];
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
