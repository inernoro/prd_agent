import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  prebuiltStagingPaths,
  parseDockerCreateId,
  fetchCdsPrebuilt,
  DOCKER_CREATE_PLACEHOLDER_CMD,
  type PrebuiltExecResult,
  type PrebuiltFetchDeps,
} from '../../src/services/cds-prebuilt-runtime.js';

const FULL = '18ffd0c44dd38b98d2e806b22205580545ff547d';
const REF = `ghcr.io/inernoro/prd_agent/cds-dist:sha-${FULL}`;

describe('prebuiltStagingPaths', () => {
  it('给出 dist/web-dist/manifest 布局，归一尾斜杠', () => {
    expect(prebuiltStagingPaths('/tmp/stage/')).toEqual({
      distDir: '/tmp/stage/dist',
      webDistDir: '/tmp/stage/web-dist',
      manifestPath: '/tmp/stage/manifest.json',
    });
  });
});

describe('parseDockerCreateId', () => {
  it('取末行 12-64 hex', () => {
    expect(parseDockerCreateId('abc123def456')).toBe('abc123def456');
    expect(parseDockerCreateId('noise\n  ABCDEF012345  ')).toBe('abcdef012345');
  });
  it('非法 → null', () => {
    expect(parseDockerCreateId('not-an-id')).toBeNull();
    expect(parseDockerCreateId('')).toBeNull();
    expect(parseDockerCreateId(undefined)).toBeNull();
  });
});

/** 用脚本化 exec 结果驱动 fetch；记录跑过的命令。 */
function makeDeps(
  execMap: (cmd: string) => PrebuiltExecResult,
  manifestText: string | null,
): { deps: PrebuiltFetchDeps; cmds: string[] } {
  const cmds: string[] = [];
  const deps: PrebuiltFetchDeps = {
    exec: async (cmd) => { cmds.push(cmd); return execMap(cmd); },
    readManifest: async () => manifestText,
    rmrf: () => undefined,
    mkdirp: () => undefined,
  };
  return { deps, cmds };
}
const ok: PrebuiltExecResult = { stdout: '', stderr: '', exitCode: 0 };

describe('fetchCdsPrebuilt', () => {
  it('异步清理真实终态前不建目录或拉取，迟到删除不会清掉新产物目录', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-prebuilt-cleanup-await-'));
    const staging = path.join(root, 'staging');
    const stale = path.join(staging, 'stale');
    fs.mkdirSync(staging); fs.writeFileSync(stale, 'previous');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const cleaning = new Promise<void>(resolve => { entered = resolve; });
    const events: string[] = [];
    const { deps, cmds } = makeDeps(cmd => cmd.startsWith('docker create')
      ? { ...ok, stdout: 'cafe1234beef' } : ok, JSON.stringify({ sha: FULL, schema: 1 }));
    let cleanup: Promise<void> | undefined;
    deps.rmrf = target => {
      cleanup = (async () => {
        events.push('cleanup-start'); entered(); await gate;
        await fs.promises.rm(target, { recursive: true, force: true }); events.push('cleanup-terminal');
      })();
      return cleanup;
    };
    deps.mkdirp = target => { events.push('mkdir'); fs.mkdirSync(target, { recursive: true }); };
    let outcomeSettled = false;
    const pending = fetchCdsPrebuilt(deps, REF, FULL, staging).finally(() => { outcomeSettled = true; });
    try {
      await cleaning;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect.soft(events).toEqual(['cleanup-start']);
      expect.soft(cmds).toEqual([]);
      expect.soft(outcomeSettled).toBe(false);
      expect(fs.readFileSync(stale, 'utf8')).toBe('previous');
    } finally {
      release(); await cleanup;
      const outcome = await pending;
      try {
        expect.soft(outcome.ok).toBe(true);
        expect.soft(events).toEqual(['cleanup-start', 'cleanup-terminal', 'mkdir', 'mkdir']);
        expect.soft(fs.existsSync(stale)).toBe(false);
        expect.soft(fs.statSync(path.join(staging, 'dist'), { throwIfNoEntry: false })?.isDirectory() ?? false).toBe(true);
        expect.soft(fs.statSync(path.join(staging, 'web-dist'), { throwIfNoEntry: false })?.isDirectory() ?? false).toBe(true);
        expect(cmds).toContain(`docker create ${REF} ${DOCKER_CREATE_PLACEHOLDER_CMD}`);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
  });

  it('异步清理失败沿原回退合同返回，不启动后续目录或外部命令', async () => {
    const { deps, cmds } = makeDeps(() => ok, JSON.stringify({ sha: FULL, schema: 1 }));
    const made: string[] = [];
    deps.rmrf = async () => { throw new Error('fixture cleanup failed'); };
    deps.mkdirp = target => { made.push(target); };
    const outcome = await fetchCdsPrebuilt(deps, REF, FULL, '/tmp/controlled-stage');
    expect(outcome).toEqual({ ok: false, reason: '预构建拉取异常: fixture cleanup failed' });
    expect(made).toEqual([]);
    expect(cmds).toEqual([]);
  });

  it('全程成功 → ok + 解出目录 + manifest', async () => {
    const { deps, cmds } = makeDeps((cmd) => {
      if (cmd.startsWith('docker create')) return { stdout: 'cafe1234beef', stderr: '', exitCode: 0 };
      return ok;
    }, JSON.stringify({ sha: FULL, schema: 1 }));
    const r = await fetchCdsPrebuilt(deps, REF, FULL, '/tmp/stage');
    expect(r.ok).toBe(true);
    expect(r.distDir).toBe('/tmp/stage/dist');
    expect(r.webDistDir).toBe('/tmp/stage/web-dist');
    expect(r.manifest?.sha).toBe(FULL);
    expect(cmds.some((c) => c.startsWith(`docker pull ${REF}`))).toBe(true);
    expect(cmds.some((c) => c.startsWith('docker rm -f cafe1234beef'))).toBe(true); // 清理容器
    // create 必须带显式命令，否则 FROM scratch 镜像无 CMD → "No command specified" 创建失败
    expect(cmds.some((c) => c === `docker create ${REF} ${DOCKER_CREATE_PLACEHOLDER_CMD}`)).toBe(true);
  });

  it('docker pull 失败 → ok:false（调用方回退现编）', async () => {
    const { deps } = makeDeps((cmd) =>
      cmd.startsWith('docker pull') ? { stdout: '', stderr: 'manifest unknown', exitCode: 1 } : ok,
    null);
    const r = await fetchCdsPrebuilt(deps, REF, FULL, '/tmp/stage');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('docker pull 失败');
  });

  it('manifest SHA 不符 → ok:false', async () => {
    const { deps } = makeDeps((cmd) =>
      cmd.startsWith('docker create') ? { stdout: 'cafe1234beef', stderr: '', exitCode: 0 } : ok,
    JSON.stringify({ sha: 'a'.repeat(40), schema: 1 }));
    const r = await fetchCdsPrebuilt(deps, REF, FULL, '/tmp/stage');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('manifest 校验失败');
  });

  it('docker create 无有效 id → ok:false', async () => {
    const { deps } = makeDeps((cmd) =>
      cmd.startsWith('docker create') ? { stdout: 'oops', stderr: '', exitCode: 0 } : ok,
    JSON.stringify({ sha: FULL, schema: 1 }));
    const r = await fetchCdsPrebuilt(deps, REF, FULL, '/tmp/stage');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('容器 id');
  });

  it('docker cp 失败 → ok:false 且仍清理容器', async () => {
    const { deps, cmds } = makeDeps((cmd) => {
      if (cmd.startsWith('docker create')) return { stdout: 'cafe1234beef', stderr: '', exitCode: 0 };
      if (cmd.startsWith('docker cp')) return { stdout: '', stderr: 'no such file', exitCode: 1 };
      return ok;
    }, JSON.stringify({ sha: FULL, schema: 1 }));
    const r = await fetchCdsPrebuilt(deps, REF, FULL, '/tmp/stage');
    expect(r.ok).toBe(false);
    expect(cmds.some((c) => c.startsWith('docker rm -f'))).toBe(true);
  });
});
