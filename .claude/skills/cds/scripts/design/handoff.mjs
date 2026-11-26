#!/usr/bin/env node
// 交接清单：由程序按目标生成，给实现方的唯一一份「要做什么」（手写的交接容易写在两处、互相不一致）。
//
//   node handoff.mjs --dir <稿件目录> --to <这一版> --from <实现方的实施基线>
//
// 读 design.json（goals、acceptance、docs）和 changes/v<from>-v<to>/summary.json，写 <稿件目录>/交接清单.md：
//   一、按目标：每个目标下列它的验收项，标出相对实施基线是「新增 / 改了 / 不变」；在别的稿件里的目标只写在哪。
//   二、不属于任何目标的验收项（基础规则）。
//   三、删掉的验收项。
//   四、源码：整份应用哪个差异文件；不能直接用的文件逐个写理由。
//   五、回复模板：实现方按验收项编号逐条回复（接受 / 怎么做 / 何时），没提到的编号视为没有接受。
// 驳回（退出码 1）：目标引用了不存在的验收项；目标没写「怎么算做到」；有目标却没有一条验收项、也没写在哪。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2); const opt = k => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const dir = path.resolve(opt('dir') ?? '.'); const to = Number(opt('to')); const from = Number(opt('from') ?? 0);
/* --from 0：首版，还没有实施基线，所有验收项都算新增（2026-11-25 DSN-2A3B7293 V1 没有生成清单） */
if (!to || !Number.isInteger(from) || from < 0 || from >= to) { console.error('用法：node handoff.mjs --dir <稿件目录> --to <这一版> [--from <实施基线，首版为 0>]'); process.exit(2); }
const design = JSON.parse(readFileSync(path.join(dir, 'design.json'), 'utf8'));
const goals = design.goals ?? [];
const items = design.acceptance ?? [];
const byId = new Map(items.map(item => [item.id, item]));
const summaryPath = path.join(dir, 'changes', `v${from}-v${to}`, 'summary.json');
const summary = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, 'utf8')) : null;
const added = new Set(from === 0 ? items.map(row => row.id) : (summary?.acceptance?.added ?? []).map(row => row.id));
const changed = new Set((summary?.acceptance?.changed ?? []).map(row => row.id));
const removed = summary?.acceptance?.removed ?? [];

const errors = [];
for (const goal of goals) {
  if (!goal.doneWhen) errors.push(`${goal.id} 没写「怎么算做到」`);
  if (!(goal.items ?? []).length && !goal.where) errors.push(`${goal.id} 没有验收项，也没写在哪`);
  for (const id of goal.items ?? []) if (!byId.has(id)) errors.push(`${goal.id} 引用了不存在的验收项 ${id}`);
}
if (errors.length) { console.error(`驳回：交接清单有 ${errors.length} 处不满足\n  ` + errors.join('\n  ')); process.exit(1); }

const mark = id => added.has(id) ? '**新增**' : changed.has(id) ? '**改了**' : '不变';
const how = { measure: '测量', human: '人工', screenshot: '截图' };
const cell = text => String(text ?? '').replace(/\|/g, '｜').replace(/\n+/g, ' ');
const row = item => `| ${item.id} | ${mark(item.id)} | ${cell(item.rule)} | ${how[item.how] ?? (item.probe ? '测量' : '—')} | ${cell(item.expected)} |`;
const head = ['| 验收项 | ' + (from === 0 ? '这一版' : '相对 V' + from) + ' | 规则 | 检查 | 怎么算通过 |', '| --- | --- | --- | --- | --- |'];
const inGoal = new Set(goals.flatMap(goal => goal.items ?? []));
const diff = (design.docs ?? []).find(doc => /\.diff$/.test(doc) && !doc.startsWith('changes/'));
const sourceFiles = diff && existsSync(path.join(dir, diff)) ? [...readFileSync(path.join(dir, diff), 'utf8').matchAll(/^diff --git a\/(\S+)/gm)].map(m => m[1]) : [];
const touched = id => added.has(id) || changed.has(id);
const order = [...items].sort((a, b) => Number(touched(b.id)) - Number(touched(a.id)));

const md = [
  from === 0 ? `# 交接清单（V${to}，首版，还没有实施基线）` : `# 交接清单（V${to}，实施基线 V${from}）`, '',
  `> 由程序生成（release.mjs check → handoff.mjs），不要手改。这是交给实现方的唯一一份清单；其他文档里的「交给实现方」以这里为准。`,
  from === 0 ? `> 首版：${added.size} 条验收项全部要实现。` : `> 相对 V${from}：新增 ${added.size} 条、改了 ${changed.size} 条、删掉 ${removed.length} 条验收项。`, '',
  '## 一、按目标', '',
  ...goals.flatMap(goal => [`### ${goal.id} ${goal.goal}`, '', `怎么算做到：${goal.doneWhen}`, '',
    ...((goal.items ?? []).length ? [...head, ...goal.items.map(id => row(byId.get(id)))] : [`在别处：${goal.where}（不在本稿交接）`]), '']),
  '## 二、不属于任何目标的验收项（基础规则）', '',
  ...(items.some(item => !inGoal.has(item.id)) ? [...head, ...items.filter(item => !inGoal.has(item.id)).map(row)] : ['没有。']), '',
  '## 三、删掉的验收项', '',
  ...(removed.length ? removed.map(item => `- ${item.id} ${item.rule ?? ''}：不再验收`) : ['没有。']), '',
  '## 四、源码', '',
  ...(diff ? [`- 整份应用 \`${diff}\`（${sourceFiles.length} 个文件），不要重写。哪个文件不能直接用，在回复里逐个写文件和理由。`, ...sourceFiles.map(file => `  - \`${file}\``)]
    : ['- 稿件没有附可直接应用的源码差异。']),
  `- 稿件包内的净变化：\`changes/v${from}-v${to}/\`。`, '',
  '## 五、回复模板（按验收项编号逐条回复，没提到的编号视为没有接受）', '',
  '| 验收项 | 接受 | 怎么做 | 何时 |', '| --- | --- | --- | --- |',
  ...order.map(item => `| ${item.id}${touched(item.id) ? '（' + (added.has(item.id) ? '新增' : '改了') + '）' : ''} |  |  |  |`), '',
];
writeFileSync(path.join(dir, '交接清单.md'), md.join('\n'));
console.log(JSON.stringify({ handoff: '交接清单.md', goals: goals.length, items: items.length, added: added.size, changed: changed.size, removed: removed.length, sourceFiles: sourceFiles.length }));
