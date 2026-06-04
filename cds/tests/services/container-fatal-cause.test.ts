import { describe, expect, it } from 'vitest';
import { detectContainerFatalCause } from '../../src/routes/branches.js';

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
