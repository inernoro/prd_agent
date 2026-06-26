/**
 * Build-command nice transform (2026-06-26).
 *
 * 源码 build/install 命令降优先级，让编译不饿死同机预览；serve 命令保持正常优先级。
 * 这是进程调度 nice，不是 docker 资源硬限（不违反 2026-05-28「不给容器加限制」约定）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { niceBuildCommands, buildNiceLevel } from '../../src/services/container.js';

describe('niceBuildCommands', () => {
  afterEach(() => {
    delete process.env.CDS_BUILD_NICE;
  });

  it('nices build/install verbs but leaves the serve verb alone', () => {
    process.env.CDS_BUILD_NICE = '10';
    const cmd = 'pnpm install --prefer-frozen-lockfile && pnpm build && pnpm start';
    const out = niceBuildCommands(cmd);
    expect(out).toBe('nice -n 10 pnpm install --prefer-frozen-lockfile && nice -n 10 pnpm build && pnpm start');
    // serve command (pnpm start) keeps normal priority
    expect(out).toContain('&& pnpm start');
    expect(out).not.toContain('nice -n 10 pnpm start');
  });

  it('does not nice dev-server (pnpm dev) — it is a long-running serve, not a finite build', () => {
    process.env.CDS_BUILD_NICE = '10';
    const cmd = 'pnpm install --prefer-frozen-lockfile && pnpm dev --host 0.0.0.0 --port 3000';
    const out = niceBuildCommands(cmd);
    expect(out).toBe('nice -n 10 pnpm install --prefer-frozen-lockfile && pnpm dev --host 0.0.0.0 --port 3000');
  });

  it('handles dotnet publish then serve', () => {
    process.env.CDS_BUILD_NICE = '12';
    const out = niceBuildCommands('dotnet restore && dotnet publish -c Release && dotnet App.dll');
    expect(out).toBe('nice -n 12 dotnet restore && nice -n 12 dotnet publish -c Release && dotnet App.dll');
    expect(out).not.toContain('nice -n 12 dotnet App.dll');
  });

  it('is idempotent — does not double-nice an already-niced verb', () => {
    process.env.CDS_BUILD_NICE = '10';
    const once = niceBuildCommands('pnpm build && pnpm start');
    const twice = niceBuildCommands(once);
    expect(twice).toBe(once);
    expect(twice).not.toContain('nice -n 10 nice -n 10');
  });

  it('off / 0 disables the transform entirely', () => {
    process.env.CDS_BUILD_NICE = 'off';
    expect(niceBuildCommands('pnpm install && pnpm build')).toBe('pnpm install && pnpm build');
    process.env.CDS_BUILD_NICE = '0';
    expect(niceBuildCommands('pnpm install && pnpm build')).toBe('pnpm install && pnpm build');
  });

  it('clamps the nice level to 1..19 and defaults to 10', () => {
    delete process.env.CDS_BUILD_NICE;
    expect(buildNiceLevel()).toBe(10);
    process.env.CDS_BUILD_NICE = '99';
    expect(buildNiceLevel()).toBe(19);
    process.env.CDS_BUILD_NICE = '5';
    expect(buildNiceLevel()).toBe(5);
  });

  it('does not match build verbs embedded mid-token', () => {
    process.env.CDS_BUILD_NICE = '10';
    // "mytsc" / "go-build" must not be niced; only standalone verbs.
    const out = niceBuildCommands('echo mytsc && ./go-build.sh && tsc -p .');
    expect(out).toBe('echo mytsc && ./go-build.sh && nice -n 10 tsc -p .');
  });
});
