import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 「防再修一边」守卫：发布事件的两处判定各只许有一份。
 *
 * 事故值：本仓库已经为「判定散成两份」付过三次学费 —— 发布步骤判定曾有三份拷贝
 * （release-service 一份、两个前端页面各一份）、终态判定在 release-service 与
 * deploy-drain 各写一份、模型解析在 gateway 里跑了两遍把用户选的模型覆盖掉。
 * 发布事件天然会长出第二个消费方（告警分发器、Activity Monitor、前端订阅），
 * 谁都可能顺手写一句 `if (status === 'failed') publish('release.failed')`，
 * 于是两边对「回滚失败算不算失败」「queued 算不算开始」的回答开始漂移。
 *
 * 本套件用源码扫描把两件事焊死：
 *   1. ReleaseRunStatus → 事件类型的映射只在 release-events.ts；
 *   2. 「哪些事件够格叫醒人」只在 cds-events-bus.ts —— 存活监控与发布必须共用这一张表，
 *      而不是各接各的告警通道（doc/debt.cds.md「CDS 存活监控（uptime-monitor）」 债务 2-1 仍是 open）。
 */

const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const LIFECYCLE_EVENT_LITERALS = [
  'release.started',
  'release.succeeded',
  'release.failed',
  'release.rolled-back',
];

/** 映射与类型声明的两个 SSOT，只有它们允许出现生命周期事件字面量。 */
const EVENT_SSOT_FILES = new Set([
  'src/services/release-events.ts',
  'src/services/cds-events-bus.ts',
]);

function walk(relativeDir: string, extensions: string[]): string[] {
  const out: string[] = [];
  const root = path.join(CDS_ROOT, relativeDir);
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        stack.push(full);
        continue;
      }
      if (extensions.some((ext) => entry.name.endsWith(ext))) {
        out.push(path.relative(CDS_ROOT, full).split(path.sep).join('/'));
      }
    }
  }
  return out;
}

describe('发布事件判定源守卫', () => {
  const sourceFiles = [
    ...walk('src', ['.ts']),
    ...walk('web/src', ['.ts', '.tsx']),
  ];

  it('生命周期事件字面量只出现在映射 SSOT 与类型声明里', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      if (EVENT_SSOT_FILES.has(file)) continue;
      // 剥注释：解释「哪些事件由映射 SSOT 产出」的注释会原样写出事件名，
      // 不剥就会被自己的说明文字触发（本 PR 已栽三次同款）。
      const text = fs.readFileSync(path.join(CDS_ROOT, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
      for (const literal of LIFECYCLE_EVENT_LITERALS) {
        if (text.includes(literal)) offenders.push(`${file} 出现 ${literal}`);
      }
    }
    expect(
      offenders,
      '发布事件类型必须从 release-events.ts 的 releaseEventTypeForStatus 取，'
        + '不许在别处按状态自己判一遍：\n' + offenders.join('\n'),
    ).toEqual([]);
  });

  it('ReleaseRunStatus 的每个成员都在映射表里被显式回答', () => {
    // 穷尽 Record 由 TS 保证，这里守的是「别有人把它改回 switch + default」——
    // 那样新增状态会被静默吞掉，发布失败不外发且不报任何错。
    const text = fs.readFileSync(path.join(CDS_ROOT, 'src/services/release-events.ts'), 'utf8');
    const statuses = fs
      .readFileSync(path.join(CDS_ROOT, 'src/types.ts'), 'utf8')
      .split('export type ReleaseRunStatus =')[1]
      ?.split(';')[0] ?? '';
    const members = [...statuses.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);

    expect(members.length).toBeGreaterThan(0);
    const mapBody = text.split('const RELEASE_STATUS_EVENT')[1]?.split('};')[0] ?? '';
    for (const member of members) {
      expect(mapBody, `ReleaseRunStatus.${member} 未在 RELEASE_STATUS_EVENT 中登记`).toContain(`${member}:`);
    }
  });

  it('告警级判定只有 cds-events-bus 一处，发布不得自建告警通道', () => {
    const offenders = sourceFiles.filter((file) => {
      if (file === 'src/services/cds-events-bus.ts') return false;
      // 剥注释：解释「哪些事件由映射 SSOT 产出」的注释会原样写出事件名，
      // 不剥就会被自己的说明文字触发（本 PR 已栽三次同款）。
      const text = fs.readFileSync(path.join(CDS_ROOT, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
      // 同一个文件里同时点名存活类与发布类告警事件 = 又长出一张自己的告警清单。
      return text.includes('preview.canary.alert') && text.includes('release.failed');
    });
    expect(
      offenders,
      '告警分发只许订阅 cdsEventsBus + isAlertCdsEvent，不许按事件名再判一遍：\n' + offenders.join('\n'),
    ).toEqual([]);
  });
});
