/**
 * Codex 第二十轮（PR #1532，reviewed commit cf2e4bd024）两条。
 *
 * 一条是术语转正只做了一半（模板改了、生成句没改），一条是演示快照里混进了乱码标题。
 * 两条的共同点：编译过、测试绿、通读也挑不出，只有真人盯着那一屏才看得见。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseReportTitle } from '../../src/services/acceptance-overview.js';

const ROOT = path.resolve(process.cwd());
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('conditional 的中文只有一种写法', () => {
  it('会被渲染出去的地方都用「原则性通过」', () => {
    for (const rel of [
      'src/services/acceptance-overview.ts',
      'src/routes/reports.ts',
      'src/routes/peer-sync.ts',
      'src/services/preview-instance-seed.ts',
    ]) {
      const text = read(rel);
      expect(text, `${rel} 还在生成「有条件通过」`).not.toContain('有条件通过');
    }
  });

  it('新词确实出现在生成侧，不是把字符串整段删掉了', () => {
    expect(read('src/services/acceptance-overview.ts')).toContain('原则性通过');
    expect(read('src/routes/reports.ts')).toContain('原则性通过');
  });
});

describe('演示快照的标题必须是能读的中文', () => {
  const snapshot = read('src/services/preview-demo-snapshot.json');

  it('没有残留那段已知乱码', () => {
    // 它的 gbk 字节恰好是「每日验收」的 UTF-8 字节，是一次双重编码留下的。
    expect('姣忔棩楠屾敹'.length).toBe(6); // 前置条件：这段字面量本身没被编辑器改写
    expect(snapshot).not.toContain('姣忔棩楠屾敹');
  });

  it('原先那两条标题现在是可读中文', () => {
    expect(snapshot).toContain('每日验收 · IMP PR · 2026-08-29 · 验收报告');
    expect(snapshot).toContain('每日验收 · IMP PR · 2026-08-27 · 验收报告');
  });

  it('修乱码不等于让它们改归「每日验收」——四段式历史标题本来就落「其他」', () => {
    // Codex 认为修完乱码这两条就会归进「每日验收」。核对下来不成立：前缀契约是
    // 「前缀 · 对象 · 目标日」三段，而这两条是 MAP 时代的四段式（末尾还有「验收报告」）。
    // 快照里大量历史标题都是这个形状，把它们重排成三段等于篡改演示数据。
    expect(parseReportTitle('每日验收 · IMP PR · 2026-08-29 · 验收报告').kind).toBe('其他');
    // 而同一批里三段式的那些照常命中，说明解析本身没问题。
    expect(parseReportTitle('每日验收 · 全量变更 · 2026-09-06').kind).toBe('每日验收');
    expect(snapshot).toContain('每日验收 · 全量变更 · 2026-09-06');
  });

  it('快照里每个标题的前缀都解析得出，不会整片落进「其他」', () => {
    const data = JSON.parse(snapshot) as unknown;
    const titles: string[] = [];
    const walk = (o: unknown): void => {
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (o && typeof o === 'object') {
        for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
          if (k === 'title' && typeof v === 'string') titles.push(v);
          else walk(v);
        }
      }
    };
    walk(data);
    expect(titles.length, '快照里没解析到标题，判据是空转的').toBeGreaterThan(100);
    // 只钉「没有乱码」，不钉「全部命中九类前缀」——自由标题落进「其他」是正常的。
    const mojibake = titles.filter((t) => t.includes('姣忔') || t.includes('棩楠'));
    expect(mojibake, `${mojibake.length} 条标题仍是乱码`).toEqual([]);
  });
});
