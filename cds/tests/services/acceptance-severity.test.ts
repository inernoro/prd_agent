import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyAcceptanceOutcome,
  formatSeveritySummary,
  normalizeDefectCounts,
} from '../../src/services/acceptance-severity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 判据守卫。两个失败方向都是**静默的**，所以必须逐条钉死：
 *  - 键名大小写不匹配 → 不报错，只是永远不告警（告警缺失最难被发现）；
 *  - 把常态形状判成阻断 → 铃天天响，人学会忽略，等于也没告警。
 */
describe('normalizeDefectCounts —— 键名归一', () => {
  it('大小写与空白随意，都归一到 P0-P3', () => {
    // cdscli 的 --defects 示例用小写，报告正文「缺陷分级速览」用大写，两边从未对齐。
    expect(normalizeDefectCounts({ p0: 1, P1: 2, ' p2 ': 3, 'P 3': 4 })).toEqual({
      P0: 1,
      P1: 2,
      P2: 3,
      P3: 4,
    });
  });

  it('不认识的键一律忽略，不做模糊匹配', () => {
    // 判据宽到能吞任意键名，就会把 p10 / priority0 误当成 P0。
    expect(normalizeDefectCounts({ p10: 5, priority0: 5, blocker: 5 })).toBeNull();
  });

  it('非有限数跳过，负数归零，小数四舍五入保住告警信号', () => {
    expect(normalizeDefectCounts({ p0: 'x', p1: -3, p2: 1.5 })).toEqual({ P1: 0, P2: 2 });
  });

  it('区分「没报计数」与「报了全 0」', () => {
    expect(normalizeDefectCounts(null)).toBeNull();
    expect(normalizeDefectCounts({})).toBeNull();
    expect(normalizeDefectCounts([1, 2])).toBeNull();
    expect(normalizeDefectCounts({ p0: 0, p1: 0 })).toEqual({ P0: 0, P1: 0 });
  });
});

describe('classifyAcceptanceOutcome —— 阻断判定', () => {
  it('verdict=fail 一律阻断，哪怕没报缺陷计数', () => {
    const out = classifyAcceptanceOutcome('fail', null);
    expect(out.blocking).toBe(true);
    expect(out.reason).toContain('不通过');
  });

  it('P0 > 0 一律阻断 —— 标准把 P0 直接定义为 fail 级', () => {
    const out = classifyAcceptanceOutcome('conditional', { p0: 2 });
    expect(out.blocking).toBe(true);
    expect(out.reason).toContain('2 个 P0');
  });

  it('大写键同样触发（归一化真的接上了，不是只在单测里成立）', () => {
    expect(classifyAcceptanceOutcome('conditional', { P0: 1 }).blocking).toBe(true);
  });

  it('自称通过却带 P0 —— 标记为结论与缺陷矛盾', () => {
    const out = classifyAcceptanceOutcome('pass', { p0: 1, p1: 0 });
    expect(out.blocking).toBe(true);
    expect(out.conflict).toBe(true);
    expect(out.reason).toContain('自相矛盾');
  });

  it('自称通过却带 P1 —— 标准原文承认自动校验抓不到，必须由本判据兜住', () => {
    const out = classifyAcceptanceOutcome('pass', { p1: 3 });
    expect(out.blocking).toBe(true);
    expect(out.conflict).toBe(true);
    expect(out.reason).toContain('3 个 P1');
  });

  it('有条件通过 + 若干 P1 —— 常态形状，刻意不叫醒人', () => {
    // 这条是「宁可少响，也不训练出忽略告警的习惯」那条纪律的落点。
    // 若哪天有人把它改成阻断，本用例会红，逼他先回答「铃天天响谁还看」。
    const out = classifyAcceptanceOutcome('conditional', { p0: 0, p1: 4, p2: 9 });
    expect(out.blocking).toBe(false);
    expect(out.conflict).toBe(false);
    expect(out.reason).toBe('');
    expect(out.counts).toEqual({ P0: 0, P1: 4, P2: 9 });
  });

  it('通过 + 全 0 —— 最常见的干净结果，静默', () => {
    expect(classifyAcceptanceOutcome('pass', { p0: 0, p1: 0, p2: 0, p3: 0 }).blocking).toBe(false);
  });

  it('没有 verdict 也没有计数 —— 非验收类报告，静默', () => {
    const out = classifyAcceptanceOutcome(null, undefined);
    expect(out.blocking).toBe(false);
    expect(out.counts).toBeNull();
  });

  it('verdict 大小写与空白不影响判定', () => {
    expect(classifyAcceptanceOutcome('  FAIL  ', null).blocking).toBe(true);
  });

  it('无法识别的 verdict 不当成 pass，避免误判成矛盾', () => {
    const out = classifyAcceptanceOutcome('通过', { p1: 2 });
    expect(out.blocking).toBe(false);
    expect(out.conflict).toBe(false);
  });
});

describe('严重度判定只有一份 —— 防判据分裂（形状 3）', () => {
  it('缺陷简报用的就是告警判据这一份，不是自己另写的同名函数', async () => {
    const digest = await import('../../src/services/acceptance-defect-digest.js');
    const severity = await import('../../src/services/acceptance-severity.js');
    // 同一个函数引用。两边各自演化的后果是「简报统计到 2 个 P0，而阻断告警从未响过」
    // —— 两边都不报错，谁也看不出自己错了，所以只能靠身份相等钉住。
    expect(digest.normalizeSeverity).toBe(severity.normalizeSeverity);
  });

  it('源码里 normalizeSeverity 的实现只出现一处', () => {
    const root = path.resolve(__dirname, '../../src');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        // 只算「函数定义」，不算 import / re-export。
        if (/export\s+function\s+normalizeSeverity\b/.test(fs.readFileSync(full, 'utf8'))) {
          hits.push(path.relative(root, full).split(path.sep).join('/'));
        }
      }
    };
    walk(root);
    expect(hits).toEqual(['services/acceptance-severity.ts']);
  });
});

describe('formatSeveritySummary', () => {
  it('只列生产者报过的档位', () => {
    expect(formatSeveritySummary({ P0: 1, P1: 2 })).toBe('P0 1 / P1 2');
  });

  it('没报计数时返回空串，不伪造 0', () => {
    expect(formatSeveritySummary(null)).toBe('');
  });
});
