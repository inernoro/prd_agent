import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCdsMenuRoutes, replaceMenuBlock, type MenuIntents } from '../src/services/cds-menu-routes.js';

// 改了 .claude/skills/cds/reference/menu-intents.json 或 Agent 任务注册表后运行；CI 驳回过期的路由表（cds-menu-routes.test.ts）。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const skill = path.join(root, '.claude/skills/cds');
const read = (file: string) => fs.readFile(file, 'utf8');
const intents = JSON.parse(await read(path.join(skill, 'reference/menu-intents.json'))) as MenuIntents;
const skillFiles: Record<string, string> = {};
for (const file of ['SKILL.md', ...(await fs.readdir(path.join(skill, 'reference'))).map(name => `reference/${name}`)]) skillFiles[file] = await read(path.join(skill, file));
const result = buildCdsMenuRoutes({ intents, appShell: await read(path.join(root, 'cds/web/src/components/layout/AppShell.tsx')), skillFiles });
if (result.errors.length) {
  console.error(`路由表不能生成：${result.errors.length} 条不满足`);
  result.errors.forEach(line => console.error('  ' + line));
  process.exit(1);
}
const next = replaceMenuBlock(skillFiles['SKILL.md'], result.block);
if (next === null) { console.error('SKILL.md 里没有 cds-menu 标记'); process.exit(1); }
await fs.writeFile(path.join(skill, 'reference/menu.md'), result.menu);
await fs.writeFile(path.join(skill, 'SKILL.md'), next);
console.log(`Updated /cds menu routes (${intents.menus.length} menus, ${intents.menus.reduce((sum, group) => sum + group.intents.length, 0)} intents)`);
// 技能文件变了，分发清单里的摘要也要跟着变；不刷新的话，cdscli 自检会报技能包不完整（2026-11-25 有会话踩到）
console.log('技能文件已改：再运行 python .claude/skills/cds/scripts/refresh_manifest.py 刷新分发清单。');
