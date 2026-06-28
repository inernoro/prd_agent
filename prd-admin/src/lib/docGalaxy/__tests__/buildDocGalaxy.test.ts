import { describe, it, expect } from 'vitest';
import { buildDocGalaxy, parseDotted, parseDocType, type GalaxyInputEntry, type GalaxyNode } from '../buildDocGalaxy';

function entry(id: string, title: string, extra: Partial<GalaxyInputEntry> = {}): GalaxyInputEntry {
  return { id, title, ...extra };
}
function childByName(node: GalaxyNode, name: string): GalaxyNode | undefined {
  return node.children.find((c) => c.name === name);
}
function leafTitles(node: GalaxyNode): string[] {
  if (node.kind === 'leaf') return [node.name];
  return node.children.flatMap(leafTitles);
}

describe('parseDotted / parseDocType', () => {
  it('解析点分名，appname 含连字符视为整段', () => {
    expect(parseDotted('design.defect-agent.automation-autonomy.md')).toEqual({
      type: 'design',
      appname: 'defect-agent',
      subs: ['automation-autonomy'],
    });
    expect(parseDotted('spec.cds.md')).toEqual({ type: 'spec', appname: 'cds', subs: [] });
  });
  it('非法前缀返回 null', () => {
    expect(parseDotted('output-xxx.md')).toBeNull();
    expect(parseDocType('foobar.md')).toBeNull();
    expect(parseDocType('guide.cds.deploy.md')).toBe('guide');
  });
});

describe('buildDocGalaxy 关系识别', () => {
  it('点分命名 → canonical 四大类根 → appname → 子模块 → 文档', () => {
    const g = buildDocGalaxy([
      entry('1', 'design.cds.agent.runtime'),
      entry('2', 'spec.cds'),
      entry('3', 'design.defect-agent.automation-autonomy'),
    ]);
    const platform = childByName(g.root, '平台基础设施');
    expect(platform).toBeTruthy();
    const cds = childByName(platform!, 'cds');
    expect(cds).toBeTruthy();
    expect(cds!.docCount).toBe(2); // spec.cds + design.cds.agent.runtime
    expect(childByName(cds!, 'agent')).toBeTruthy();
    const appAgent = childByName(g.root, '应用 Agent');
    expect(childByName(appAgent!, 'defect-agent')).toBeTruthy();
  });

  it('周报走「周报」例外根', () => {
    const g = buildDocGalaxy([entry('w1', 'report.2026-W13'), entry('w2', 'report.2026-W25')]);
    const weekly = childByName(g.root, '周报');
    expect(weekly).toBeTruthy();
    expect(weekly!.docCount).toBe(2);
  });

  it('未知 appname → 未分类 + 标记悬空', () => {
    const g = buildDocGalaxy([entry('o1', 'guide.list.directory')]);
    const unclassified = childByName(g.root, '未分类');
    expect(unclassified).toBeTruthy();
    expect(g.stats.orphanCount).toBe(1);
    expect(g.leaves[0].orphan).toBe(true);
  });

  it('非点分名 → 走 parentId 文件夹层级（通用知识库）', () => {
    const g = buildDocGalaxy([
      entry('f1', '产品手册', { isFolder: true }),
      entry('f2', '第一章', { isFolder: true, parentId: 'f1' }),
      entry('d1', '开篇介绍', { parentId: 'f2' }),
    ]);
    const folder = childByName(g.root, '产品手册');
    expect(folder).toBeTruthy();
    const ch1 = childByName(folder!, '第一章');
    expect(ch1).toBeTruthy();
    expect(leafTitles(ch1!)).toContain('开篇介绍');
    expect(g.stats.totalDocs).toBe(1); // 文件夹不计入文档
  });

  it('title 非点分但 sourceUrl 是点分文件名 → 用 sourceUrl 解析', () => {
    const g = buildDocGalaxy([
      entry('s1', '缺陷自动化自治体系 · 设计', {
        sourceUrl: 'https://github.com/x/repo/blob/main/doc/design.defect-agent.automation-autonomy.md',
      }),
    ]);
    const appAgent = childByName(g.root, '应用 Agent');
    expect(childByName(appAgent!, 'defect-agent')).toBeTruthy();
  });

  it('双链：仅保留两端都是文档叶的边并去重', () => {
    const g = buildDocGalaxy(
      [entry('a', 'design.cds.a'), entry('b', 'design.cds.b')],
      [
        { from: 'a', to: 'b', anchorText: 'x' },
        { from: 'b', to: 'a' }, // 反向重复
        { from: 'a', to: 'ghost' }, // 目标不存在 → 丢弃
        { from: 'a', to: 'a' }, // 自环 → 丢弃
      ],
    );
    expect(g.links).toHaveLength(1);
    expect(g.links[0].source).toBe('e:a');
    expect(g.links[0].target).toBe('e:b');
  });

  it('统计：文档数 / 根数 / 类型分布', () => {
    const g = buildDocGalaxy([
      entry('1', 'design.cds.a'),
      entry('2', 'guide.cds.b'),
      entry('3', 'report.2026-W01'),
      entry('4', 'guide.unknownapp.x'),
    ]);
    expect(g.stats.totalDocs).toBe(4);
    expect(g.stats.typeCounts.design).toBe(1);
    expect(g.stats.typeCounts.guide).toBe(2);
    expect(g.stats.typeCounts.report).toBe(1);
    expect(g.stats.orphanCount).toBe(1); // unknownapp
    // 根：平台基础设施 + 周报 + 未分类
    expect(g.stats.rootCount).toBe(3);
  });

  it('可注入自定义 classifyAppname（通用库不依赖 canonical 表）', () => {
    const g = buildDocGalaxy([entry('1', 'design.myapp.x')], [], {
      classifyAppname: () => '我的分组',
    });
    expect(childByName(g.root, '我的分组')).toBeTruthy();
  });
});
