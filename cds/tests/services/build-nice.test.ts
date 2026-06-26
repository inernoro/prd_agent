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

  // 前导定义：镜像有 nice 才用，没有则降级为空（不因缺 nice 让构建失败）。
  const PREAMBLE = (n: number) => `NICE=$(command -v nice >/dev/null 2>&1 && echo 'nice -n ${n}'); `;

  it('nices build/install verbs but leaves the serve verb alone', () => {
    process.env.CDS_BUILD_NICE = '10';
    const cmd = 'pnpm install --prefer-frozen-lockfile && pnpm build && pnpm start';
    const out = niceBuildCommands(cmd);
    expect(out).toBe(`${PREAMBLE(10)}$NICE pnpm install --prefer-frozen-lockfile && $NICE pnpm build && pnpm start`);
    // serve command (pnpm start) keeps normal priority
    expect(out).toContain('&& pnpm start');
    expect(out).not.toContain('$NICE pnpm start');
  });

  it('does not nice dev-server (pnpm dev) — it is a long-running serve, not a finite build', () => {
    process.env.CDS_BUILD_NICE = '10';
    const cmd = 'pnpm install --prefer-frozen-lockfile && pnpm dev --host 0.0.0.0 --port 3000';
    const out = niceBuildCommands(cmd);
    expect(out).toBe(`${PREAMBLE(10)}$NICE pnpm install --prefer-frozen-lockfile && pnpm dev --host 0.0.0.0 --port 3000`);
  });

  it('handles dotnet publish then serve', () => {
    process.env.CDS_BUILD_NICE = '12';
    const out = niceBuildCommands('dotnet restore && dotnet publish -c Release && dotnet App.dll');
    expect(out).toBe(`${PREAMBLE(12)}$NICE dotnet restore && $NICE dotnet publish -c Release && dotnet App.dll`);
    expect(out).not.toContain('$NICE dotnet App.dll');
  });

  it('is idempotent — does not double-wrap an already-processed command', () => {
    process.env.CDS_BUILD_NICE = '10';
    const once = niceBuildCommands('pnpm build && pnpm start');
    const twice = niceBuildCommands(once);
    expect(twice).toBe(once);
    expect(twice).not.toContain('$NICE $NICE');
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
    expect(out).toBe(`${PREAMBLE(10)}echo mytsc && ./go-build.sh && $NICE tsc -p .`);
  });

  it('leaves a serve-only command untouched (no preamble when nothing matched)', () => {
    process.env.CDS_BUILD_NICE = '10';
    expect(niceBuildCommands('node server.js')).toBe('node server.js');
    expect(niceBuildCommands('pnpm start')).toBe('pnpm start');
  });
});
