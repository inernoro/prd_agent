import path from 'node:path';
import type { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import type { SelfMaintenanceRuntime, SelfMaintenanceOwner, SelfMaintenanceCheckpoint } from './self-maintenance-runtime.js';
import { shellQuote } from './sidecar/sidecar-deployer.js';

export const CDS_RESTART_PERMIT_COMMAND = 'IFS= read -r permit <&3 && [ "$permit" = restart ] && exec bash ./exec_cds.sh daemon';

/** 子脚本只等待本次pipe许可；关闭pipe即撤销，尚未调用任何daemon/supervisor。 */
export function prepareDetachedCdsRestart(spawnProcess: typeof spawn, cwd: string, env: NodeJS.ProcessEnv,
  stdio: ['ignore', number | 'ignore', number | 'ignore']) {
  const child = spawnProcess('bash', ['-p', '-c', CDS_RESTART_PERMIT_COMMAND], {
    cwd, env, detached: true, stdio: [...stdio, 'pipe'],
  });
  const pipe = child.stdio[3] as Writable | null;
  let failure: Error | undefined;
  child.on('error', error => { failure = error; });
  pipe?.on('error', error => { failure = error; });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.unref();
  return {
    hasChildPid: Number.isSafeInteger(child.pid) && (child.pid ?? 0) > 0,
    async release() {
      if (!pipe || failure || child.exitCode !== null || child.signalCode !== null) {
        throw failure ?? new Error('CDS 重启脚本已退出，已取消本次重启。');
      }
      await new Promise<void>((resolve, reject) => pipe.write('restart\n', error => error ? reject(error) : resolve()));
      pipe.end();
    },
    async cancel() { pipe?.end(); await closed; },
  };
}

/** 独立副本包含产物及依赖；产物去引用，pnpm符号链保留原链接，不使用硬链接或重签SHA。 */
export async function createSelfUpdateCheckpoint(runtime: SelfMaintenanceRuntime, owner: SelfMaintenanceOwner,
  repoRoot: string, captureOptions: { deferArtifacts?: boolean } = {}) {
  const options = { cwd: repoRoot, timeout: 30_000 };
  const sha = (await runtime.exec(owner, 'git rev-parse HEAD', options)).stdout.trim();
  const branchResult = await runtime.exec(owner, 'git symbolic-ref --quiet --short HEAD', options);
  if (!/^[0-9a-f]{40}$/i.test(sha) || branchResult.exitCode > 1) throw new Error('无法保存 CDS 原版本，已停止更新。');
  const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : '';
  const cdsDir = path.join(repoRoot, 'cds');
  let checkpoint: SelfMaintenanceCheckpoint | undefined;
  let finished = false, artifactsSaved = false, artifactsRestored = false, discarded = false;
  const discard = async () => {
    if (!checkpoint || discarded) return;
    try { await runtime.files(owner, 'discard', checkpoint); discarded = true; }
    catch (error) {
      // 清理失败不能反向回滚已保持的新代或二次破坏已恢复的五目录；unknown仍由runtime持票。
      console.warn(`[self-update] 恢复副本清理未确认，未将其记作已删除：${checkpoint.backupPath}`, error);
    }
  };
  const commit = async () => {
    if (finished) return;
    await discard(); finished = true;
  };
  // Git身份必须在checkout/reset前取得；五目录只在实际改产物/依赖前保存。
  const captureArtifacts = async () => {
    if (finished) throw new Error('CDS 版本恢复保护已经结束，已停止保存产物。');
    if (artifactsSaved) return;
    if (checkpoint) throw new Error('CDS 产物恢复点未完整保存，已停止重复保存。');
    checkpoint = runtime.prepareCheckpoint(owner);
    try {
      await runtime.files(owner, 'snapshot', checkpoint); artifactsSaved = true;
    } catch (error) {
      runtime.requestStop(owner);
      // discard只处置未完成副本，不结束Git保护；晚期失败仍须恢复早期源码身份。
      await discard(); throw error;
    }
  };
  if (!captureOptions.deferArtifacts) await captureArtifacts();
  return {
    commit, captureArtifacts,
    retainForRestart() {
      if (!owner.restartScheduled || !artifactsSaved || !checkpoint) {
        throw new Error('CDS 重启许可或产物恢复点尚未确认，不能结束版本恢复保护。');
      }
      // permit写出后新daemon可立即启动；此处绝不派发深删或借用旧一秒退出窗口。
      finished = true;
      console.warn(`[self-update] 重启已交接，安全恢复副本保留待清理：${checkpoint.backupPath}`);
    },
    async rollback() {
      if (finished) return;
      runtime.requestStop(owner);
      if (artifactsSaved && !artifactsRestored) {
        const receipt = await runtime.files(owner, 'restore', checkpoint!);
        artifactsRestored = receipt.artifactsRestored;
      }
      const restored = await runtime.exec(owner, branch
        ? `git checkout -f -B ${shellQuote(branch)} ${sha}` : `git checkout -f --detach ${sha}`, options, true);
      if (restored.exitCode !== 0) throw new Error(artifactsSaved
        ? 'CDS 产物已恢复，但源码恢复失败；已停止更新，请检查控制面工作树。'
        : 'CDS 源码恢复失败；已停止更新，请检查控制面工作树。');
      const rendered = await runtime.exec(owner, './exec_cds.sh nginx-render', { cwd: cdsDir, timeout: 15_000 }, true);
      if (rendered.exitCode !== 0) throw new Error('CDS 原版本已恢复，但入口配置恢复失败；请检查 CDS 系统日志。');
      await commit();
    },
  };
}
