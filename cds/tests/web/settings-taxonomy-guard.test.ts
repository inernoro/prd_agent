/**
 * 设置页分组词表守卫。
 *
 * 组名的**合法性**已经由类型挡住（TabGroup.label: SettingsGroupLabel），这里守的是
 * 类型挡不住的两件事：
 *   1. 组的先后顺序跟词表一致（危险区永远垫底，常用永远在最前）；
 *   2. 「常用」只允许出现在系统设置；项目设置页签少，直接按问题找。
 * 再加一条：每个页签只属于一个组，别在两个组里重复登记。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DATA_CLASS_META,
  DATA_CLASS_ORDER,
  SETTINGS_GROUP_META,
  SETTINGS_GROUP_ORDER,
  compareSettingsGroups,
} from '../../web/src/lib/settingsTaxonomy.js';

const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readGroups(file: string): Array<{ label: string; values: string[] }> {
  const source = fs.readFileSync(path.join(CDS_ROOT, file), 'utf8');
  const start = source.indexOf('const tabGroups: TabGroup[] = [');
  expect(start, `${file} 里找不到 tabGroups`).toBeGreaterThan(-1);
  const end = source.indexOf('const tabs: TabItem[] = tabGroups.flatMap', start);
  const block = source.slice(start, end);
  const groups: Array<{ label: string; values: string[] }> = [];
  const re = /label:\s*'([^']+)',\s*items:\s*\[([\s\S]*?)\],\s*\}/g;
  for (const m of block.matchAll(re)) {
    const values = [...m[2].matchAll(/value:\s*'([a-z0-9-]+)'/g)].map((v) => v[1]);
    groups.push({ label: m[1], values });
  }
  expect(groups.length, `${file} 没解析出任何分组——锚点变了就得回来改这条`).toBeGreaterThan(2);
  return groups;
}

const PAGES = {
  project: 'web/src/pages/ProjectSettingsPage.tsx',
  system: 'web/src/pages/CdsSettingsPage.tsx',
} as const;

describe('设置分组词表', () => {
  it('六组各回答一个问题，危险区垫底、常用在前', () => {
    expect(SETTINGS_GROUP_ORDER[0]).toBe('常用');
    expect(SETTINGS_GROUP_ORDER[SETTINGS_GROUP_ORDER.length - 1]).toBe('危险区');
    for (const label of SETTINGS_GROUP_ORDER) {
      expect(SETTINGS_GROUP_META[label].question.length).toBeGreaterThan(3);
    }
    expect(compareSettingsGroups('接入', '数据')).toBeLessThan(0);
    expect(compareSettingsGroups('危险区', '观测')).toBeGreaterThan(0);
    expect(compareSettingsGroups('未知', '常用')).toBeGreaterThan(0);
  });

  it('数据分类四类各说清可再生 / 要不要备份 / 随不随分支删', () => {
    expect(DATA_CLASS_ORDER).toEqual(['配置', '业务数据', '运行态', '审计证据']);
    expect(DATA_CLASS_META['业务数据'].regenerable).toBe(false);
    expect(DATA_CLASS_META['业务数据'].backup).toBe(true);
    expect(DATA_CLASS_META['运行态'].backup).toBe(false);
    expect(DATA_CLASS_META['运行态'].perBranchLifecycle).toBe(true);
  });
});

describe.each(Object.entries(PAGES))('%s 设置页的分组', (scope, file) => {
  const groups = readGroups(file);

  it('组名全在词表里，且按词表顺序排列', () => {
    const labels = groups.map((g) => g.label);
    for (const label of labels) {
      expect(SETTINGS_GROUP_ORDER as readonly string[], `组名「${label}」不在词表里`).toContain(label);
    }
    const sorted = [...labels].sort(compareSettingsGroups);
    expect(labels).toEqual(sorted);
  });

  it('危险区单独成组、垫底；每组至少一个页签', () => {
    expect(groups[groups.length - 1].label).toBe('危险区');
    for (const g of groups) expect(g.values.length, `组「${g.label}」是空的`).toBeGreaterThan(0);
  });

  it('每个页签只登记在一个组里', () => {
    const seen = new Map<string, string>();
    for (const g of groups) {
      for (const v of g.values) {
        expect(seen.has(v), `页签 ${v} 同时出现在「${seen.get(v)}」和「${g.label}」`).toBe(false);
        seen.set(v, g.label);
      }
    }
  });

  it('「常用」快捷组只允许系统设置有', () => {
    const hasCommon = groups.some((g) => g.label === '常用');
    expect(hasCommon).toBe(scope === 'system');
    expect(SETTINGS_GROUP_META['常用'].systemOnly).toBe(true);
  });
});
