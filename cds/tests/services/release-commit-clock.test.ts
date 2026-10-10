import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_COMMIT_TIME_ENTRIES,
  ReleaseCommitClock,
  gitCommitMetaReader,
  isCommitShaLike,
  releaseCommitKey,
} from '../../src/services/release-commit-clock.js';
import { IsolatedShellExecutor } from '../../src/services/isolated-shell-executor.js';
import { ShellExecutor } from '../../src/services/shell-executor.js';
const readPool = new IsolatedShellExecutor(new ShellExecutor(), { isolatedLane: 'operation', concurrency: 2 });
beforeAll(async () => { await readPool.start(); });
afterAll(async () => { await readPool.close(); });

/**
 * 真实 git 读取的「只要时间」口径。
 *
 * 以前这里测的是 gitCommitTimeReader —— 一个全委托给 gitCommitMetaReader 的窄包装，
 * 生产代码一个调用方都没有（默认 reader 用的是 gitCommitMetaReader 本身）。
 * 包装删掉后，这三条用例直接打在真正被接上的那个 reader 上：断言的行为一字未改，
 * 但覆盖的是生产路径而不是一层没人用的壳。
 */
const readCommitTime = async (worktreePath: string, commitSha: string): Promise<string | undefined> => {
  const meta = (await gitCommitMetaReader(worktreePath, commitSha, readPool));
  return typeof meta === 'string' ? meta : meta?.at;
};

/**
 * commit 时间台账回归。
 *
 * 补测理由：这个模块是 DORA 四项里「变更前置时间」的**唯一**数据源，
 * 而验收扫描时它一条测试都没有。取不到时间只会让指标静默显示「样本不足」，
 * 坏掉了不会有任何东西变红 —— 与本轮另外几处「一行接线掉了只会静默退化」同形。
 *
 * 事故值有两个方向：
 *  - 记不上（reader 坏了 / 缓存没生效）→ 前置时间永远 null，用户以为功能没做；
 *  - 记错了（拿了别的时间戳顶替）→ 给出一个看着精确的假前置时间，比没有更糟。
 * 另外 sha 会拼进 git 的 argv：以 `-` 开头的值会被 git 当成选项（`--upload-pack=`
 * 这类可以直接执行命令），execFile 不过 shell 挡得住管道、挡不住这一层。
 */

describe('commit sha 形状白名单', () => {
  it('放行真实 sha（短 sha 与全长都算）', () => {
    expect(isCommitShaLike('a1b2c3d')).toBe(true);
    expect(isCommitShaLike('e'.repeat(40))).toBe(true);
    expect(isCommitShaLike('DEADBEEF')).toBe(true);
  });

  it('拦下会被 git 当成选项的值——这是命令执行面，不是洁癖', () => {
    // 事故值：--upload-pack=/bin/sh 这类进到 argv 里就是一次任意命令执行。
    expect(isCommitShaLike('--upload-pack=/bin/sh')).toBe(false);
    expect(isCommitShaLike('-c')).toBe(false);
    expect(isCommitShaLike('HEAD')).toBe(false);
    expect(isCommitShaLike('a1b2c3d; rm -rf /')).toBe(false);
    expect(isCommitShaLike('a1b2c')).toBe(false); // 短于 7 位
    expect(isCommitShaLike('')).toBe(false);
  });
});

describe('真实 git 读取器', () => {
  let repo: string;
  let sha: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-commit-clock-repo-'));
    const git = (...args: string[]): string =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
    git('config', 'user.email', 'test@example.test');
    git('config', 'user.name', 'test');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hello');
    git('add', 'a.txt');
    // 钉死提交时间，才能断言读到的就是 committer date 而不是「现在」。
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], {
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: '2026-01-02T03:04:05+00:00',
        GIT_COMMITTER_DATE: '2026-01-02T03:04:05+00:00',
      },
    });
    sha = git('rev-parse', 'HEAD').trim();
  });

  afterEach(() => {
    if (fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
  });

  it('读到的是 committer date 本身，不是「现在」', async () => {
    expect((await readCommitTime(repo, sha))).toBe('2026-01-02T03:04:05.000Z');
  });

  it('worktree 已被回收 / sha 不在本地 → undefined，不抛给发布主链路', async () => {
    expect((await readCommitTime(path.join(repo, '不存在'), sha))).toBeUndefined();
    expect((await readCommitTime(repo, 'f'.repeat(40)))).toBeUndefined();
  });

  it('形状不合法的 sha 压根不起 git 进程', async () => {
    expect((await readCommitTime(repo, '--upload-pack=/bin/echo'))).toBeUndefined();
    expect((await readCommitTime('', sha))).toBeUndefined();
  });
});

describe('台账行为', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-commit-clock-'));
  });

  afterEach(() => {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('记一次之后不再起第二次 git 进程', async () => {
    let calls = 0;
    const clock = new ReleaseCommitClock({
      reader: () => { calls += 1; return '2026-01-02T03:04:05.000Z'; },
    });

    expect((await clock.remember('p1', 'a'.repeat(40), '/w'))).toBe('2026-01-02T03:04:05.000Z');
    expect((await clock.remember('p1', 'a'.repeat(40), '/w'))).toBe('2026-01-02T03:04:05.000Z');
    // 事故值：不缓存的话，发布中心每被打开一次就按 run 数放大出一串 git 进程。
    expect(calls).toBe(1);
  });

  it('读不到就不记，绝不拿别的时间戳顶替', async () => {
    const clock = new ReleaseCommitClock({ reader: () => undefined });

    expect((await clock.remember('p1', 'b'.repeat(40), '/w'))).toBeUndefined();
    expect(clock.get('p1', 'b'.repeat(40))).toBeUndefined();
  });

  it('reader 抛异常被吞掉——统计旁路不许炸掉发布', async () => {
    const clock = new ReleaseCommitClock({ reader: () => { throw new Error('git 炸了'); } });

    await expect(clock.remember('p1', 'c'.repeat(40), '/w')).resolves.toBeUndefined();
    expect(clock.get('p1', 'c'.repeat(40))).toBeUndefined();
  });

  it('缺 projectId / sha / worktree 任一都不记', async () => {
    const clock = new ReleaseCommitClock({ reader: () => '2026-01-02T03:04:05.000Z' });

    expect((await clock.remember('', 'd'.repeat(40), '/w'))).toBeUndefined();
    expect((await clock.remember('p1', '', '/w'))).toBeUndefined();
    expect((await clock.remember('p1', 'd'.repeat(40), undefined))).toBeUndefined();
  });

  it('不同项目的同一个 sha 各记各的，不串台', async () => {
    const clock = new ReleaseCommitClock({
      reader: (worktree) => (worktree === '/w1' ? '2026-01-01T00:00:00.000Z' : '2026-02-02T00:00:00.000Z'),
    });
    const sha = 'e'.repeat(40);

    (await clock.remember('p1', sha, '/w1'));
    (await clock.remember('p2', sha, '/w2'));

    expect(clock.get('p1', sha)).toBe('2026-01-01T00:00:00.000Z');
    expect(clock.get('p2', sha)).toBe('2026-02-02T00:00:00.000Z');
    expect(releaseCommitKey('p1', sha)).not.toBe(releaseCommitKey('p2', sha));
  });

  it('条数有上界，超出丢最旧——台账不许无界增长', async () => {
    const clock = new ReleaseCommitClock({ maxEntries: 3, reader: () => '2026-01-02T03:04:05.000Z' });
    for (let i = 0; i < 5; i += 1) (await clock.remember('p1', String(i).repeat(8), '/w'));

    // 事故值：无上界时这里会留 5 条，跑够久就是又一份无界增长的台账。
    expect(clock.get('p1', '0'.repeat(8))).toBeUndefined();
    expect(clock.get('p1', '1'.repeat(8))).toBeUndefined();
    expect(clock.get('p1', '4'.repeat(8))).toBe('2026-01-02T03:04:05.000Z');
    expect(MAX_COMMIT_TIME_ENTRIES).toBeGreaterThan(0);
  });

  it('落盘后新实例能读回来（跨重启前置时间不清零）', async () => {
    const storePath = path.join(dir, '.cds', 'release-commit-times.json');
    const first = new ReleaseCommitClock({ storePath, reader: () => '2026-03-03T03:03:03.000Z' });
    (await first.remember('p1', 'f'.repeat(40), '/w'));

    const second = new ReleaseCommitClock({ storePath, reader: () => undefined });

    expect(second.get('p1', 'f'.repeat(40))).toBe('2026-03-03T03:03:03.000Z');
  });

  it('台账文件损坏时从空开始并留痕，不炸', () => {
    const storePath = path.join(dir, '.cds', 'release-commit-times.json');
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, '{ 这不是 JSON');
    const warnings: string[] = [];
    const clock = new ReleaseCommitClock({ storePath, reader: () => undefined, logger: { warn: (m) => warnings.push(m) } });

    expect(clock.get('p1', 'a'.repeat(40))).toBeUndefined();
    expect(warnings.some((w) => w.includes('[release-commit-clock]'))).toBe(true);
  });

  it('无 storePath 时纯内存，不往 process.cwd() 写东西', async () => {
    const before = fs.readdirSync(process.cwd());
    const clock = new ReleaseCommitClock({ reader: () => '2026-01-02T03:04:05.000Z' });
    (await clock.remember('p1', 'a'.repeat(40), '/w'));

    expect(clock.get('p1', 'a'.repeat(40))).toBe('2026-01-02T03:04:05.000Z');
    expect(fs.readdirSync(process.cwd())).toEqual(before);
  });
});
