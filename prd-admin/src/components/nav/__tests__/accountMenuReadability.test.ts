import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 账号菜单（侧栏头像下拉）可读性守卫。
 *
 * 2026-09-24 用户反馈「有些字看不清、教程很突兀」：原菜单右侧补充说明是 10px 灰字，
 * 角标写死琥珀色 #fbbf24（浅色下黄字压淡黄底），分隔线是 4% 透明的渐变几乎看不见。
 * 这里钉住两件事，防止改回去：
 * 1. 菜单里没有 9px / 10px 的字；
 * 2. 菜单里没有写死的 hex 颜色，一律走主题 token。
 */

const root = resolve(__dirname, '../../..');
const rowSource = readFileSync(resolve(root, 'components/nav/AccountMenuRow.tsx'), 'utf8');
const shellSource = readFileSync(resolve(root, 'layouts/AppShell.tsx'), 'utf8');

const START = '{/* 用户信息区';
const END = '{/* 提交缺陷按钮（仅展开时显示';

function menuRegion(): string {
  const start = shellSource.indexOf(START);
  const end = shellSource.indexOf(END, start);
  // 标记找不到时直接红，不许静默空跑（空字符串会让下面的断言全部假绿）
  expect(start, `AppShell 里找不到菜单起点标记「${START}」`).toBeGreaterThan(-1);
  expect(end, `AppShell 里找不到菜单终点标记「${END}」`).toBeGreaterThan(start);
  return shellSource.slice(start, end);
}

const TINY_TEXT = /text-\[(9|10)px\]|fontSize:\s*(9|10)\b/g;
const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/g;

describe('账号菜单可读性', () => {
  it('共享行组件没有 9/10px 的字', () => {
    expect(rowSource.match(TINY_TEXT) ?? []).toEqual([]);
  });

  it('共享行组件不写死 hex 颜色', () => {
    expect(rowSource.match(HEX_COLOR) ?? []).toEqual([]);
  });

  it('桌面菜单区段没有 9/10px 的字', () => {
    expect(menuRegion().match(TINY_TEXT) ?? []).toEqual([]);
  });

  it('桌面菜单区段不写死 hex 颜色', () => {
    expect(menuRegion().match(HEX_COLOR) ?? []).toEqual([]);
  });

  it('桌面菜单的每一行都走共享行外观', () => {
    const region = menuRegion();
    const rows = region.match(/<DropdownMenu\.(?:Item|CheckboxItem)\b[^>]*className=\{([A-Z_]+)\}/g) ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const row of rows) expect(row).toContain('ACCOUNT_MENU_ROW_CLASS');
  });
});
