/**
 * release-service-single-instance.test.ts —— 全进程只能有一个 ReleaseService。
 *
 * 「目标忙不忙」的判据一半在共享 state（终态 run），另一半只在实例内存里：
 * `inFlight` 记着「已终态但健康探测仍在收尾」那段 settling。两个实例各有各的
 * inFlight，于是路由侧正在收尾的发布对调度器完全不可见 —— isTargetBusy 与
 * startRelease 的双重闸门同时放行，旧发布的收尾逻辑会覆盖掉新发布的结果
 * （Codex review P1，2026-07-29；此前作为 debt #6 记录在案）。
 *
 * 这条不变式只存在于**接线**里：多 new 一个实例编译照样过、单测照样绿，
 * 只有真并发才会现形。所以必须有源码守卫。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel: string): string => fs.readFileSync(path.resolve(here, '../../src', rel), 'utf8');

describe('ReleaseService 实例唯一', () => {
  it('server.ts 只 new 一次', () => {
    const source = src('server.ts');
    const occurrences = source.match(/new ReleaseService\(/g) || [];
    expect(occurrences).toHaveLength(1);
  });

  it('server.ts 把那一个实例注入发布路由', () => {
    const source = src('server.ts');
    // 从挂载点往后取一段：不能用别的 router 名当右边界，import 段里也有它们，
    // indexOf 会取到文件开头、切出一个反向空串，于是断言恒真（假绿）。
    const at = source.indexOf('createReleasesRouter({');
    expect(at).toBeGreaterThan(-1);
    expect(source.slice(at, at + 400)).toContain('releaseService,');
  });

  it('server.ts 把同一个实例注入定时调度器', () => {
    const source = src('server.ts');
    const mount = source.slice(
      source.indexOf('new ScheduledJobService({'),
      source.indexOf('scheduledJobService.start()'),
    );
    expect(mount).toContain('release: releaseService,');
  });

  it('发布路由不再无条件自建实例', () => {
    const source = src('routes/releases.ts');
    // 允许 `deps.releaseService ?? new ReleaseService(...)`（单测 / 嵌入式用法），
    // 但不允许无视注入直接 new —— 那正是这次事故的形状。
    expect(source).toContain('deps.releaseService ?? new ReleaseService(');
    expect(source).not.toMatch(/const service = new ReleaseService\(/);
  });

  it('发布路由的 deps 暴露了这个注入口', () => {
    expect(src('routes/releases.ts')).toMatch(/releaseService\?:\s*ReleaseService;/);
  });
});

describe('commit 元信息记在服务层而不是 HTTP 处理器里', () => {
  it('ReleaseService 提供 onRunStarted，并在两处建 run 的地方都触发', () => {
    const source = src('services/release-service.ts');
    expect(source).toContain('onRunStarted(hook:');
    // startRelease 与 startRollback 各建一次 run，少一处就少一类发布不进台账。
    const notifications = source.match(/this\.notifyRunStarted\(/g) || [];
    expect(notifications).toHaveLength(2);
  });

  it('路由把 rememberCommitTime 挂在服务层，而不是逐个 handler 调', () => {
    const source = src('routes/releases.ts');
    expect(source).toContain('service.onRunStarted(rememberCommitTime)');
    // 回到 handler 里逐个调，定时发布就又统计不到了。
    expect(source).not.toContain('rememberCommitTime(run);');
  });
});
