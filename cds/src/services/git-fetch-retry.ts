import type { IShellExecutor } from '../types.js';
import { isSafeGitRef } from './github-webhook-dispatcher.js';

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
 *
 * 安全性:branch 来自远端 webhook / git rev-parse 输出,可能含 shell metacharacters。
 * shell.exec 走 child_process.exec(整串 shell 解释),所以本函数内做 isSafeGitRef 守门
 * 作为 defense-in-depth —— 即使新 caller 忘了在外层 sanitize,这里也兜得住,返回
 * 退非 0 的合成结果让上游统一走错误分支。
 */
export async function fetchWithLockRetry(
  shell: IShellExecutor,
  cwd: string,
  branch: string,
  options: { maxAttempts?: number; timeoutMs?: number } = {},
): Promise<Awaited<ReturnType<IShellExecutor['exec']>>> {
  if (!isSafeGitRef(branch)) {
    return {
      exitCode: 128,
      stdout: '',
      stderr: `fetchWithLockRetry: refusing unsafe branch ref ${JSON.stringify(branch).slice(0, 80)}`,
    };
  }
  const maxAttempts = options.maxAttempts ?? 3;
  // ⚠ Bugbot 2026-05-06 b66fb1c3:maxAttempts=0 时下面的 for 循环不进,lastResult
  // 永远 undefined,return lastResult! 撒谎(类型说是 ShellExecResult,实际 undefined)。
  // 调用方很难想得到这个边角,直接返回合成的失败结果保护类型契约。
  if (maxAttempts <= 0) {
    return {
      exitCode: 128,
      stdout: '',
      stderr: `fetchWithLockRetry: maxAttempts=${maxAttempts} 不合法(必须 ≥1)`,
    };
  }
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
