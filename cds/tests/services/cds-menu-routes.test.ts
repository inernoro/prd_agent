import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCdsMenuRoutes, MENU_BLOCK_END, MENU_BLOCK_START, type MenuIntents } from '../../src/services/cds-menu-routes.js';

const root = path.resolve(process.cwd(), '..');
const skill = path.join(root, '.claude/skills/cds');
const read = (file: string) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const intents = JSON.parse(read(path.join(skill, 'reference/menu-intents.json'))) as MenuIntents;
const skillFiles = Object.fromEntries(['SKILL.md', ...fs.readdirSync(path.join(skill, 'reference')).map(name => `reference/${name}`)]
  .map(file => [file, read(path.join(skill, file))]));
const appShell = read(path.join(root, 'cds/web/src/components/layout/AppShell.tsx'));

describe('/cds 按菜单的路由表', () => {
  it('每个 Agent 任务都有说法，菜单都在左侧导航里，文档小节都存在', () => {
    expect(buildCdsMenuRoutes({ intents, appShell, skillFiles }).errors).toEqual([]);
  });

  it('提交的 menu.md 和 SKILL.md 摘要与注册表一致（改了任务或说法要运行 sync-cds-menu-routes.ts）', () => {
    const result = buildCdsMenuRoutes({ intents, appShell, skillFiles });
    expect(skillFiles['reference/menu.md']).toBe(result.menu);
    const skillText = skillFiles['SKILL.md'];
    expect(skillText.slice(skillText.indexOf(MENU_BLOCK_START), skillText.indexOf(MENU_BLOCK_END) + MENU_BLOCK_END.length)).toBe(result.block);
  });

  it('指向不存在的任务、没人说的任务和不在导航里的菜单都会被驳回', () => {
    const broken: MenuIntents = { menus: [{ menu: '不存在的菜单', say: 'x', intents: [{ say: ['做点什么'], mission: 'no-such-mission' }] }] };
    const { errors } = buildCdsMenuRoutes({ intents: broken, appShell, skillFiles });
    expect(errors.some(line => line.includes('不在左侧导航'))).toBe(true);
    expect(errors.some(line => line.includes('no-such-mission'))).toBe(true);
    expect(errors.some(line => line.includes('没有对应的说法'))).toBe(true);
  });
});
