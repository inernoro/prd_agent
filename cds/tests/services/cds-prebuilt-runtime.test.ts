import { describe, it, expect } from 'vitest';
import {
  prebuiltStagingPaths,
  parseDockerCreateId,
  fetchCdsPrebuilt,
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
