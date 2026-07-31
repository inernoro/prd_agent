/**
 * commit 元信息台账（v2）回归。
 *
 * 台账从「只记提交时间」升级成「时间 + 说明 + 作者」。两个方向的事故值都不会自己变红：
 *
 *  - **v1 兼容**：线上那份 `.cds/release-commit-times.json` 里已经攒了一批裸 ISO 条目，
 *    它们是 DORA 变更前置时间**仅有**的样本源。加载器不认 v1 = 升级当天样本清零，
 *    而指标只会显示「样本不足」——静默退化，没有任何东西会报错。
 *  - **不许编造**：读不到 subject 就不给，前端退化成只显示 short sha；绝不拿
 *    分支名 / 操作人顶替（那会给出一个看着像提交说明的假信息）。
 *
 * 另外 sha 会拼进 git 的 argv：以 `-` 开头的值会被 git 当成选项，必须在起进程之前就挡住。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_COMMIT_SUBJECT_LENGTH,
  ReleaseCommitClock,
  gitCommitMetaReader,
  releaseCommitKey,
} from '../../src/services/release-commit-clock.js';

describe('台账文件版本兼容', () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-commit-meta-'));
    storePath = path.join(dir, '.cds', 'release-commit-times.json');
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('v1 的裸 ISO 条目照常读得回来——升级不许清零已有前置时间样本', () => {
    const sha = 'a'.repeat(40);
    fs.writeFileSync(storePath, JSON.stringify({
      version: 1,
      savedAt: '2026-07-01T00:00:00.000Z',
      entries: [[releaseCommitKey('p1', sha), '2026-06-30T10:00:00.000Z']],
    }));

    const clock = new ReleaseCommitClock({ storePath, reader: () => undefined });

    expect(clock.get('p1', sha)).toBe('2026-06-30T10:00:00.000Z');
    // v1 条目只有时间，没有说明——如实缺省，不编一个出来。
    expect(clock.getMeta('p1', sha)?.subject).toBeUndefined();
  });

  it('v2 的对象条目带回说明与作者', () => {
    const sha = 'b'.repeat(40);
    fs.writeFileSync(storePath, JSON.stringify({
      version: 2,
      savedAt: '2026-07-01T00:00:00.000Z',
      entries: [[releaseCommitKey('p1', sha), {
        at: '2026-06-30T10:00:00.000Z',
        subject: 'fix: 修好了网关门禁',
        author: '张三',
      }]],
    }));

    const clock = new ReleaseCommitClock({ storePath, reader: () => undefined });

    expect(clock.getMeta('p1', sha)).toEqual({
      at: '2026-06-30T10:00:00.000Z',
      subject: 'fix: 修好了网关门禁',
      author: '张三',
    });
  });

  it('写出来的是 v2，且新旧实例都能读回说明', () => {
    const sha = 'c'.repeat(40);
    const first = new ReleaseCommitClock({
      storePath,
      reader: () => ({ at: '2026-06-30T10:00:00.000Z', subject: 'feat: 新东西', author: '李四' }),
    });
    first.remember('p1', sha, '/w');

    const saved = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    expect(saved.version).toBe(2);

    const second = new ReleaseCommitClock({ storePath, reader: () => undefined });
    expect(second.getMeta('p1', sha)?.subject).toBe('feat: 新东西');
    // get() 的形状不变，DORA 那边一行都不用改。
    expect(second.get('p1', sha)).toBe('2026-06-30T10:00:00.000Z');
  });

  it('损坏的条目被跳过，其余照常加载', () => {
    const good = 'd'.repeat(40);
    fs.writeFileSync(storePath, JSON.stringify({
      version: 2,
      savedAt: '2026-07-01T00:00:00.000Z',
      entries: [
        ['坏条目'],
        [releaseCommitKey('p1', 'e'.repeat(40)), { at: '不是时间' }],
        [releaseCommitKey('p1', good), { at: '2026-06-30T10:00:00.000Z' }],
      ],
    }));

    const clock = new ReleaseCommitClock({ storePath, reader: () => undefined });

    expect(clock.get('p1', good)).toBe('2026-06-30T10:00:00.000Z');
    expect(clock.get('p1', 'e'.repeat(40))).toBeUndefined();
  });
});

describe('元信息归一', () => {
  it('说明截断到上界——台账要落盘、要随响应下发，不能无界', () => {
    const clock = new ReleaseCommitClock({
      reader: () => ({ at: '2026-06-30T10:00:00.000Z', subject: '啊'.repeat(500) }),
    });
    clock.remember('p1', 'f'.repeat(40), '/w');

    expect(clock.getMeta('p1', 'f'.repeat(40))?.subject).toHaveLength(MAX_COMMIT_SUBJECT_LENGTH);
  });

  it('只给时间的旧 reader 仍然合法——退化成「有时间没说明」', () => {
    const clock = new ReleaseCommitClock({ reader: () => '2026-06-30T10:00:00.000Z' });

    expect(clock.remember('p1', 'a'.repeat(40), '/w')).toBe('2026-06-30T10:00:00.000Z');
    expect(clock.getMeta('p1', 'a'.repeat(40))?.subject).toBeUndefined();
  });

  it('空白说明 / 空白作者当作没有，不落一个空字符串进台账', () => {
    const clock = new ReleaseCommitClock({
      reader: () => ({ at: '2026-06-30T10:00:00.000Z', subject: '   ', author: '' }),
    });
    clock.remember('p1', 'b'.repeat(40), '/w');

    const meta = clock.getMeta('p1', 'b'.repeat(40));
    expect(meta?.at).toBe('2026-06-30T10:00:00.000Z');
    expect(meta?.subject).toBeUndefined();
    expect(meta?.author).toBeUndefined();
  });

  it('时间无效整条不记——没有时间的元信息对 DORA 没有意义', () => {
    const clock = new ReleaseCommitClock({ reader: () => ({ at: '不是时间', subject: 'feat: x' }) });

    expect(clock.remember('p1', 'c'.repeat(40), '/w')).toBeUndefined();
    expect(clock.getMeta('p1', 'c'.repeat(40))).toBeUndefined();
  });
});

describe('多候选 worktree', () => {
  it('分支 worktree 已回收时回落项目主 clone', () => {
    const tried: string[] = [];
    const clock = new ReleaseCommitClock({
      reader: (worktree) => {
        tried.push(worktree);
        return worktree === '/repo' ? { at: '2026-06-30T10:00:00.000Z', subject: 'feat: x' } : undefined;
      },
    });

    expect(clock.remember('p1', 'd'.repeat(40), '/gone', '/repo')).toBe('2026-06-30T10:00:00.000Z');
    expect(tried).toEqual(['/gone', '/repo']);
  });

  it('候选全失败就是不记，绝不猜一个时间', () => {
    const clock = new ReleaseCommitClock({ reader: () => undefined });

    expect(clock.remember('p1', 'e'.repeat(40), '/gone', '/also-gone')).toBeUndefined();
    expect(clock.getMeta('p1', 'e'.repeat(40))).toBeUndefined();
  });

  it('重复 / 空候选不重复起进程', () => {
    let calls = 0;
    const clock = new ReleaseCommitClock({ reader: () => { calls += 1; return undefined; } });

    clock.remember('p1', 'f'.repeat(40), '/repo', undefined, '/repo', '');

    expect(calls).toBe(1);
  });
});

describe('真实 git 元信息读取器', () => {
  let repo: string;
  let sha: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-commit-meta-repo-'));
    const git = (...args: string[]): string =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
    git('config', 'user.email', 'test@example.test');
    git('config', 'user.name', '发布测试');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hello');
    git('add', 'a.txt');
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'fix: 门禁 401 的真实原因'], {
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

  it('一次 git 调用同时带回时间 / 说明 / 作者', () => {
    expect(gitCommitMetaReader(repo, sha)).toEqual({
      at: '2026-01-02T03:04:05.000Z',
      subject: 'fix: 门禁 401 的真实原因',
      author: '发布测试',
    });
  });

  it('形状不合法的 sha 压根不起 git 进程', () => {
    // 事故值：--upload-pack=/bin/sh 这类进到 argv 里就是一次任意命令执行。
    expect(gitCommitMetaReader(repo, '--upload-pack=/bin/echo')).toBeUndefined();
    expect(gitCommitMetaReader(repo, 'HEAD')).toBeUndefined();
  });

  it('worktree 已回收 / sha 不在本地 → undefined，不抛给发布主链路', () => {
    expect(gitCommitMetaReader(path.join(repo, '不存在'), sha)).toBeUndefined();
    expect(gitCommitMetaReader(repo, 'f'.repeat(40))).toBeUndefined();
  });
});
