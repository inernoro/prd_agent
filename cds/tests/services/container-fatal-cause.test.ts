import { describe, expect, it } from 'vitest';
import { detectContainerFatalCause, buildCheckRunFailurePostmortem } from '../../src/routes/branches.js';

// 用最小 stub 顶替 ContainerService.getLogs
function fakeContainerService(logsByName: Record<string, string>) {
  return {
    getLogs: async (name: string) => {
      if (!(name in logsByName)) throw new Error('no such container');
      return logsByName[name];
    },
  };
}

// 回归:容器内编译/构建失败导致就绪探测超时时,根因必须从日志里被点名出来,
// 而不是被顶层 errorMessage("就绪探测超时")淹没、最终误判成"未分类/CDS 侧"。
describe('detectContainerFatalCause', () => {
  it('从带 docker 时间戳前缀的日志里识别 C# 编译错误并归到代码侧', () => {
    const logs = [
      '2026-06-04T08:06:18.961205339Z /repo/prd-api/src/PrdAgent.Api/Controllers/Api/ProductAgentController.cs(2206,14): error CS0101: The namespace already contains a definition for AddCommentRequest',
      '2026-06-04T08:06:18.961515003Z Build FAILED.',
    ].join('\n');
    const cause = detectContainerFatalCause(logs);
    expect(cause).not.toBeNull();
    expect(cause!.side).toBe('code');
    expect(cause!.category).toBe('build-failed');
    // 时间戳前缀被剥掉,正文里点名了具体的 CS 错误
    expect(cause!.summary).toContain('error CS0101');
    expect(cause!.summary).not.toContain('2026-06-04T08:06:18');
  });

  it('识别 TypeScript 编译错误', () => {
    const cause = detectContainerFatalCause('src/app.ts(10,3): error TS2304: Cannot find name foo');
    expect(cause?.side).toBe('code');
    expect(cause?.category).toBe('build-failed');
  });

  it('识别依赖缺失(模块未找到)', () => {
    const cause = detectContainerFatalCause("Error: Cannot find module 'express'");
    expect(cause?.side).toBe('code');
    expect(cause?.category).toBe('missing-deps');
  });

  it('识别端口被占用并归到配置侧', () => {
    const cause = detectContainerFatalCause('Error: listen EADDRINUSE: address already in use :::5000');
    expect(cause?.side).toBe('config');
    expect(cause?.category).toBe('port-conflict');
  });

  it('日志里没有已知根因模式时返回 null(降级到通用文案)', () => {
    expect(detectContainerFatalCause('Now listening on http://0.0.0.0:5000\nApplication started.')).toBeNull();
    expect(detectContainerFatalCause('')).toBeNull();
    expect(detectContainerFatalCause('   \n  ')).toBeNull();
  });

  it('编译失败优先于其它噪音:多行日志只点名首个 build 错误', () => {
    const logs = [
      'info: starting build',
      'Foo.cs(1,1): error CS1002: ; expected',
      'warning: something else',
    ].join('\n');
    const cause = detectContainerFatalCause(logs);
    expect(cause?.category).toBe('build-failed');
    expect(cause?.summary).toContain('error CS1002');
  });
});

// 回归:agent 在沙箱里读不到 CDS,但能从 GitHub PR Check 读到根因。
// buildCheckRunFailurePostmortem 必须把真实编译错误+日志尾部点名出来。
describe('buildCheckRunFailurePostmortem', () => {
  it('没有 error 服务时返回空串', async () => {
    const entry = { services: { api: { status: 'running', containerName: 'c-api' } } } as any;
    expect(await buildCheckRunFailurePostmortem(entry, fakeContainerService({}))).toBe('');
  });

  it('error 服务的容器日志里有 CS 编译错误 → 点名根因 + 代码侧 + 折叠日志', async () => {
    const entry = {
      services: { 'api-prd-agent': { status: 'error', containerName: 'c-api', errorMessage: '就绪探测超时' } },
    } as any;
    const logs = [
      '2026-06-04T08:06:18.961205339Z Foo.cs(2206,14): error CS0101: already contains a definition for AddCommentRequest',
      '2026-06-04T08:06:18.961515003Z Build FAILED.',
    ].join('\n');
    const md = await buildCheckRunFailurePostmortem(entry, fakeContainerService({ 'c-api': logs }));
    expect(md).toContain('失败根因');
    expect(md).toContain('api-prd-agent');
    expect(md).toContain('代码侧');
    expect(md).toContain('error CS0101');
    expect(md).toContain('<details>');
    // 时间戳前缀被剥掉
    expect(md).not.toContain('2026-06-04T08:06:18');
  });

  it('拉不到容器日志时降级用 errorMessage 作为根因,不抛错', async () => {
    const entry = {
      services: { api: { status: 'error', containerName: 'gone', errorMessage: '容器已丢失' } },
    } as any;
    const md = await buildCheckRunFailurePostmortem(entry, fakeContainerService({}));
    expect(md).toContain('未识别');
    expect(md).toContain('容器已丢失');
  });

  // 回归(Codex):传入 activeProfileIds 时,只诊断本次 startup-plan 的活跃服务,
  // 不能把已删/改名残留的 zombie error 服务当成本次失败根因。
  it('activeProfileIds 过滤掉 zombie error 服务', async () => {
    const entry = {
      services: {
        'api-live': { status: 'error', containerName: 'c-live', errorMessage: '活跃服务失败' },
        'old-zombie': { status: 'error', containerName: 'c-zombie', errorMessage: '残留旧服务' },
      },
    } as any;
    const active = new Set(['api-live']);
    const md = await buildCheckRunFailurePostmortem(entry, fakeContainerService({}), active);
    expect(md).toContain('api-live');
    expect(md).not.toContain('old-zombie');
    expect(md).not.toContain('残留旧服务');
    // 不传 activeProfileIds 时维持旧行为(全列)
    const mdAll = await buildCheckRunFailurePostmortem(entry, fakeContainerService({}));
    expect(mdAll).toContain('old-zombie');
  });
});
