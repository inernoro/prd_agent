/**
 * 主干流水轴 / 落后领先计数回归。
 *
 * 三个方向的事故值，每个都不会自己变红：
 *  - 解析错（subject 含分隔符被截断、shortSha 取错）→ 时间线显示半句话，没人会认为是 bug；
 *  - 算不出却给 0 → 「与主干齐平」是个很强的结论，把「读不到」显示成齐平比不显示更糟；
 *  - 缓存没生效 → 打开发布中心就按目标数放大成一串 git 进程，功能照常「对」。
 */
import { describe, expect, it } from 'vitest';
import {
  ReleaseCommitRailReader,
  parseCount,
  parseRailLog,
} from '../../src/services/release-commit-rail.js';

const US = '\x1f';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

function railLog(rows: Array<[string, string, string]>): string {
  return rows.map(([sha, at, subject]) => `${sha}${US}${at}${US}${subject}`).join('\n') + '\n';
}

/** 记录每次 git 调用，并按 argv 内容给出假输出。抛异常 = git 失败。 */
function makeRunner(reply: (args: string[]) => string | undefined) {
  const calls: string[][] = [];
  const runner = (args: readonly string[]): string => {
    calls.push([...args]);
    const out = reply([...args]);
    if (out === undefined) throw new Error(`fake git failed: ${args.join(' ')}`);
    return out;
  };
  return { runner, calls };
}

function defaultReply(args: string[]): string | undefined {
  const joined = args.join(' ');
  if (joined.includes('rev-parse')) return `${SHA_A}\n`;
  if (args.includes('log') && args.some((a) => a.startsWith('--format=%H'))) {
    return railLog([
      [SHA_A, '2026-07-29T10:00:00+00:00', 'feat: 顶端提交'],
      [SHA_B, '2026-07-28T09:00:00+00:00', 'fix: 中间提交'],
      [SHA_C, '2026-07-27T08:00:00+00:00', 'chore: 更早的提交'],
    ]);
  }
  if (args.includes('rev-list')) {
    const range = args[args.length - 1];
    if (range === `${SHA_C}..origin/main`) return '2\n';
    if (range === `origin/main..${SHA_C}`) return '0\n';
    return '0\n';
  }
  if (args.includes('log')) return '2026-07-28T09:00:00+00:00\n';
  return '';
}

function readerFor(
  reply: (args: string[]) => string | undefined,
  options: { repoRoot?: string | undefined; now?: () => number } = {},
) {
  const { runner, calls } = makeRunner(reply);
  const reader = new ReleaseCommitRailReader({
    repoRootResolver: () => ('repoRoot' in options ? options.repoRoot : '/repo'),
    runner,
    ...(options.now ? { now: options.now } : {}),
  });
  return { reader, calls };
}

describe('纯函数解析', () => {
  it('流水轴按新到旧解析出 sha / shortSha / 时间 / 说明', () => {
    const nodes = parseRailLog(railLog([
      [SHA_A, '2026-07-29T10:00:00+00:00', 'feat: 新的'],
      [SHA_B, '2026-07-28T09:00:00+00:00', 'fix: 旧的'],
    ]));

    expect(nodes.map((n) => n.sha)).toEqual([SHA_A, SHA_B]);
    expect(nodes[0].shortSha).toBe(SHA_A.slice(0, 7));
    expect(nodes[0].committedAt).toBe('2026-07-29T10:00:00.000Z');
    expect(nodes[1].subject).toBe('fix: 旧的');
  });

  it('说明里出现分隔符时不许把尾巴切掉', () => {
    // 事故值：用 split 取第三段，说明里只要有一个分隔符就只剩前半句，
    // 时间线上显示半句话，谁也不会觉得那是 bug。
    const nodes = parseRailLog(`${SHA_A}${US}2026-07-29T10:00:00+00:00${US}fix: a${US}b${US}c\n`);
    expect(nodes[0].subject).toBe(`fix: a${US}b${US}c`);
  });

  it('脏行直接丢弃，不产出半个节点', () => {
    expect(parseRailLog('')).toEqual([]);
    expect(parseRailLog('没有分隔符\n')).toEqual([]);
    expect(parseRailLog(`不是sha${US}2026-07-29T10:00:00+00:00${US}x\n`)).toEqual([]);
    expect(parseRailLog(`${SHA_A}${US}不是时间${US}x\n`)).toEqual([]);
  });

  it('计数解析不出来一律 null，绝不退化成 0', () => {
    expect(parseCount('7\n')).toBe(7);
    expect(parseCount('0\n')).toBe(0);
    // 事故值：这几个若返回 0，UI 会说「与主干齐平」——一个很强却是编造的结论。
    expect(parseCount('')).toBeNull();
    expect(parseCount('fatal: bad revision\n')).toBeNull();
    expect(parseCount('-1\n')).toBeNull();
  });
});

describe('流水轴读取', () => {
  it('正常情况给出节点、refsAsOf 与该环境的落点', () => {
    const { reader } = readerFor(defaultReply);

    const result = reader.read({
      projectId: 'proj-a',
      branch: 'main',
      targets: [{ targetId: 't1', commitSha: SHA_C }],
    });

    expect(result.rail.unavailableReason).toBeUndefined();
    expect(result.rail.ref).toBe('origin/main');
    expect(result.rail.nodes).toHaveLength(3);
    // refsAsOf 如实暴露「本地 ref 截至什么时候」——不 fetch 的代价要说出来，不掩盖。
    expect(result.rail.refsAsOf).toBe('2026-07-29T10:00:00.000Z');

    const position = result.positions.t1;
    expect(position.behindCount).toBe(2);
    expect(position.aheadCount).toBe(0);
    expect(position.inRail).toBe(true);
    expect(position.oldestUnreleasedAt).toBe('2026-07-28T09:00:00.000Z');
  });

  it('分叉时 behind 与 ahead 同时非零，两个都如实给出', () => {
    // 事故值：只算一个方向、另一个靠相减推，分叉时给出的是个无声的错数。
    const { reader } = readerFor((args) => {
      if (args.includes('rev-list')) {
        const range = args[args.length - 1];
        if (range === `${SHA_C}..origin/main`) return '5\n';
        if (range === `origin/main..${SHA_C}`) return '3\n';
      }
      return defaultReply(args);
    });

    const position = reader.read({
      projectId: 'proj-a',
      branch: 'main',
      targets: [{ targetId: 't1', commitSha: SHA_C }],
    }).positions.t1;

    expect(position.behindCount).toBe(5);
    expect(position.aheadCount).toBe(3);
  });

  it('本地没有该 ref → 有人话原因、nodes 为空、落点全 null', () => {
    const { reader } = readerFor((args) => (args.includes('rev-parse') ? undefined : defaultReply(args)));

    const result = reader.read({
      projectId: 'proj-a',
      branch: 'main',
      targets: [{ targetId: 't1', commitSha: SHA_C }],
    });

    expect(result.rail.nodes).toEqual([]);
    expect(result.rail.unavailableReason).toContain('main');
    expect(result.positions.t1.behindCount).toBeNull();
    expect(result.positions.t1.aheadCount).toBeNull();
    expect(result.positions.t1.reason).toBeTruthy();
  });

  it('项目没有本地仓库路径 → 不可用原因说清是路径的事', () => {
    const { reader, calls } = readerFor(defaultReply, { repoRoot: undefined });

    const result = reader.read({ projectId: 'proj-a', branch: 'main', targets: [] });

    expect(result.rail.nodes).toEqual([]);
    expect(result.rail.unavailableReason).toContain('本地仓库路径');
    // 连 git 都不该起：没有工作目录，起了也只是白白抛一次异常。
    expect(calls).toHaveLength(0);
  });

  it('项目没记远端默认分支 → 不可用而不是瞎猜一个 main', () => {
    const { reader, calls } = readerFor(defaultReply);

    const result = reader.read({ projectId: 'proj-a', branch: null, targets: [] });

    expect(result.rail.unavailableReason).toContain('默认分支');
    expect(calls).toHaveLength(0);
  });

  it('分支名不过 ref 白名单时压根不进 argv', () => {
    // sha / ref 最终是 git 的命令行参数：`-` 开头的值会被当成选项。
    const { reader, calls } = readerFor(defaultReply);

    const result = reader.read({ projectId: 'proj-a', branch: '--upload-pack=/bin/sh', targets: [] });

    expect(result.rail.unavailableReason).toContain('白名单');
    expect(calls).toHaveLength(0);
  });

  it('git 整体不可用 → 退化成不可用，不抛给调用方', () => {
    const { reader } = readerFor(() => undefined);

    const result = reader.read({
      projectId: 'proj-a',
      branch: 'main',
      targets: [{ targetId: 't1', commitSha: SHA_C }],
    });

    expect(result.rail.nodes).toEqual([]);
    expect(result.rail.unavailableReason).toBeTruthy();
  });

  it('该环境从未发布过（无 commit）→ 给原因，不算成落后 0', () => {
    const { reader } = readerFor(defaultReply);

    const position = reader.read({
      projectId: 'proj-a',
      branch: 'main',
      targets: [{ targetId: 't1', commitSha: '' }],
    }).positions.t1;

    expect(position.behindCount).toBeNull();
    expect(position.inRail).toBe(false);
    expect(position.reason).toContain('成功发布过');
  });

  it('本地查不到该 commit → 两个方向都 null 且给原因', () => {
    const { reader } = readerFor((args) => (args.includes('rev-list') ? undefined : defaultReply(args)));

    const position = reader.read({
      projectId: 'proj-a',
      branch: 'main',
      targets: [{ targetId: 't1', commitSha: SHA_C }],
    }).positions.t1;

    expect(position.behindCount).toBeNull();
    expect(position.aheadCount).toBeNull();
    expect(position.reason).toContain(SHA_C.slice(0, 7));
  });

  it('TTL 内同样的输入不再起 git 进程', () => {
    let clock = 1_000;
    const { reader, calls } = readerFor(defaultReply, { now: () => clock });
    const input = { projectId: 'proj-a', branch: 'main', targets: [{ targetId: 't1', commitSha: SHA_C }] };

    reader.read(input);
    const firstCallCount = calls.length;
    expect(firstCallCount).toBeGreaterThan(0);
    reader.read(input);
    // 事故值：不缓存的话，每打开一次发布中心就按目标数放大成一串 git 进程。
    expect(calls).toHaveLength(firstCallCount);

    clock += 120_000;
    reader.read(input);
    expect(calls.length).toBeGreaterThan(firstCallCount);
  });

  it('目标的版本变了就重算，不吃过期缓存', () => {
    const { reader, calls } = readerFor(defaultReply, { now: () => 1_000 });

    reader.read({ projectId: 'proj-a', branch: 'main', targets: [{ targetId: 't1', commitSha: SHA_C }] });
    const firstCallCount = calls.length;
    reader.read({ projectId: 'proj-a', branch: 'main', targets: [{ targetId: 't1', commitSha: SHA_B }] });

    expect(calls.length).toBeGreaterThan(firstCallCount);
  });
});

describe('跨环境提交距离直算', () => {
  it('给出 from..to 的提交数', () => {
    const { reader, calls } = readerFor((args) => (args.includes('rev-list') ? '4\n' : defaultReply(args)));

    expect(reader.countCommitsBetween('proj-a', SHA_C, SHA_A)).toBe(4);
    expect(calls.at(-1)?.at(-1)).toBe(`${SHA_C}..${SHA_A}`);
  });

  it('同一个 commit 直接 0，不起 git', () => {
    const { reader, calls } = readerFor(defaultReply);

    expect(reader.countCommitsBetween('proj-a', SHA_A, SHA_A)).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('sha 形状不合法一律 null 且不进 argv', () => {
    const { reader, calls } = readerFor(defaultReply);

    expect(reader.countCommitsBetween('proj-a', '--upload-pack=/bin/sh', SHA_A)).toBeNull();
    expect(reader.countCommitsBetween('proj-a', SHA_A, 'HEAD')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('git 失败 → null，不是 0', () => {
    const { reader } = readerFor((args) => (args.includes('rev-list') ? undefined : defaultReply(args)));

    expect(reader.countCommitsBetween('proj-a', SHA_C, SHA_A)).toBeNull();
  });
});
