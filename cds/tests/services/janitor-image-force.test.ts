import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 「must be forced」镜像的受控强删（2026-07-27 生产实测）。
 *
 * 实测每轮固定有 1 个 admin 镜像卡在
 * `conflict: unable to delete ... (must be forced)`——该镜像 ID 还挂着别的 tag
 * 或子引用。不处理就是永远失败下去的噪音，且那部分空间永远收不回。
 *
 * 但直接 -f 是危险的：停止容器依赖的镜像被强删后，那个容器再也起不来。
 * 所以只在「此刻确认没有任何容器引用它」之后才重试，且检查失败一律不强删。
 */
const execCalls: string[][] = [];
let execResults: Record<string, string> = {};

vi.mock('node:child_process', () => ({
  execFile: (_cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
    execCalls.push(args);
    const key = args.join(' ');
    const hit = Object.entries(execResults).find(([k]) => key.includes(k));
    const val = hit ? hit[1] : '';
    if (val.startsWith('ERR:')) cb(new Error('x'), '', val.slice(4));
    else cb(null, val, '');
  },
  execSync: () => '',
  spawn: () => ({ stdout: { on: () => undefined }, on: () => undefined, kill: () => undefined }),
}));

const { defaultImageDocker, IMAGE_HELD_PREFIX } = await import('../../src/services/janitor.js');

describe('镜像强删的安全边界', () => {
  beforeEach(() => { execCalls.length = 0; execResults = {}; });

  it('无容器引用时，must-be-forced 的镜像会被受控强删', async () => {
    execResults = {
      'rmi -f img:tag': 'Deleted: sha256:x',
      'rmi img:tag': 'ERR:conflict: unable to delete img:tag (must be forced) - image is referenced in multiple repositories',
      'ps -a --filter ancestor=img:tag': '',
    };
    expect(await defaultImageDocker.removeImage('img:tag')).toBeNull();
    expect(execCalls.some((a) => a.includes('-f'))).toBe(true);
  });

  it('有容器引用时绝不强删——停止容器依赖的镜像删了就起不来', async () => {
    execResults = {
      'rmi img:tag': 'ERR:conflict: unable to delete img:tag (must be forced)',
      'ps -a --filter ancestor=img:tag': 'c0ffee\n',
    };
    const err = await defaultImageDocker.removeImage('img:tag');
    expect(err).toContain('有容器引用');
    expect(execCalls.some((a) => a.includes('-f'))).toBe(false);
  });

  it('引用检查本身失败时也不强删（查不清就不动）', async () => {
    execResults = {
      'rmi img:tag': 'ERR:conflict: unable to delete img:tag (must be forced)',
      'ps -a --filter ancestor=img:tag': 'ERR:docker daemon unreachable',
    };
    const err = await defaultImageDocker.removeImage('img:tag');
    expect(err).toContain('未强制删除');
    expect(execCalls.some((a) => a.includes('-f'))).toBe(false);
  });

  it('其他错误原样返回，不触发强删路径', async () => {
    execResults = { 'rmi img:tag': 'ERR:image is being used by running container abc' };
    const err = await defaultImageDocker.removeImage('img:tag');
    expect(err).toContain('running container');
    expect(execCalls.some((a) => a.includes('-f'))).toBe(false);
  });
});

describe('held 与 failed 必须分开（2026-07-28 生产实测）', () => {
  beforeEach(() => { execCalls.length = 0; execResults = {}; });

  // 生产上每轮固定有一个 admin 镜像被停止容器引用而删不掉，于是
  // /api/janitor/state 的 failed 与 errors 恒为 1——一个永远亮着的红灯，
  // 真出新故障时反而分辨不出来。有正当理由的保留必须与真失败分开计数。
  it('有容器引用时返回 HELD 前缀，供调用方归类为「按住不删」', async () => {
    execResults = {
      'rmi img:tag': 'ERR:conflict: unable to delete img:tag (must be forced) - image is being used by stopped container abc',
      'ps -a --filter ancestor=img:tag': 'abc123\n',
    };
    const r = await defaultImageDocker.removeImage('img:tag');
    expect(r).not.toBeNull();
    expect(r!.startsWith(IMAGE_HELD_PREFIX)).toBe(true);
    // 未走强删
    expect(execCalls.some((a) => a.includes('-f') && a.includes('rmi'))).toBe(false);
  });

  it('引用检查本身失败也算 held（保守不强删），同样不计入 failed', async () => {
    execResults = {
      'rmi img:tag': 'ERR:conflict: unable to delete img:tag (must be forced) -',
      'ps -a --filter ancestor=img:tag': 'ERR:docker daemon 不可用',
    };
    const r = await defaultImageDocker.removeImage('img:tag');
    expect(r!.startsWith(IMAGE_HELD_PREFIX)).toBe(true);
  });

  it('真正的删除失败不带 HELD 前缀（仍要计入 failed 并报警）', async () => {
    execResults = { 'rmi img:tag': 'ERR:some other docker failure' };
    const r = await defaultImageDocker.removeImage('img:tag');
    expect(r).toBe('some other docker failure');
    expect(r!.startsWith(IMAGE_HELD_PREFIX)).toBe(false);
  });
});
