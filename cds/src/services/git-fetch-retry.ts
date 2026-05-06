import type { IShellExecutor } from '../types.js';

/**
 * git fetch with lock-aware retry —— 同一 repo 短时间内并发 fetch 时
 * (webhook 多 push 撞上 / 多分支 deploy 同时跑 / SSE broadcast 撞 deploy worker)
 * git 会报 `cannot lock ref 'refs/remotes/origin/xxx': is at YYY but expected ZZZ`
 * 这类 ref-lock 冲突。这是瞬时错误,等几秒就好。
 *
 * 重试策略:最多 3 次,间隔 2s / 4s(线性退避);非 lock 错误立即返回不重试
 * (避免掩盖真实问题如网络断 / 凭据失效)。
 *
 * SSOT 提示:WorktreeService.create / branches.ts computeSelfStatusPayload 都走这一份。
 * 修退避或 lock 正则时只动这里,不要再 inline。
 */
export async function fetchWithLockRetry(
  shell: IShellExecutor,
  cwd: string,
  branch: string,
  options: { maxAttempts?: number; timeoutMs?: number } = {},
): Promise<Awaited<ReturnType<IShellExecutor['exec']>>> {
  const maxAttempts = options.maxAttempts ?? 3;
  const execOpts: { cwd: string; timeout?: number } = { cwd };
  if (options.timeoutMs !== undefined) execOpts.timeout = options.timeoutMs;
  let lastResult: Awaited<ReturnType<IShellExecutor['exec']>> | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await shell.exec(`git fetch origin ${branch}`, execOpts);
    if (result.exitCode === 0) return result;
    lastResult = result;
    const stderr = (result.stderr || '') + (result.stdout || '');
    const isLockErr = /cannot lock ref|unable to create.*lock/i.test(stderr);
    if (!isLockErr || attempt === maxAttempts) return result;
    await new Promise((r) => setTimeout(r, 2_000 * attempt));
  }
  return lastResult!;
}
