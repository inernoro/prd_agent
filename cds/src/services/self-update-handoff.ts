import fs from 'node:fs';
import path from 'node:path';
import type { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import type { IShellExecutor } from '../types.js';
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
export async function createSelfUpdateCheckpoint(shell: IShellExecutor, repoRoot: string,
  replace: (pairs: { currentPath: string; nextPath: string }[]) => void) {
  const options = { cwd: repoRoot, timeout: 30_000 };
  const sha = (await shell.exec('git rev-parse HEAD', options)).stdout.trim();
  const branchResult = await shell.exec('git symbolic-ref --quiet --short HEAD', options);
  if (!/^[0-9a-f]{40}$/i.test(sha) || branchResult.exitCode > 1) throw new Error('无法保存 CDS 原版本，已停止更新。');
  const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : '';
  const cdsDir = path.join(repoRoot, 'cds');
  fs.mkdirSync(path.join(cdsDir, '.cds'), { recursive: true });
  const backup = fs.mkdtempSync(path.join(cdsDir, '.cds', 'restart-rollback-'));
  const copies = ['dist', 'web/dist', 'web/dist.previous', 'node_modules', 'web/node_modules'].map((relative, index) => ({
    currentPath: path.join(cdsDir, relative), nextPath: path.join(backup, String(index)),
    existed: fs.existsSync(path.join(cdsDir, relative)), preserveLinks: relative.endsWith('node_modules'),
  }));
  let finished = false, artifactsRestored = false;
  const commit = () => {
    try { fs.rmSync(backup, { recursive: true, force: true }); }
    catch (error) { console.warn('[self-update] rollback backup cleanup failed', error); }
    finished = true;
  };
  try {
    for (const copy of copies) if (copy.existed) await fs.promises.cp(copy.currentPath, copy.nextPath, {
      recursive: true, dereference: !copy.preserveLinks, verbatimSymlinks: copy.preserveLinks, mode: fs.constants.COPYFILE_FICLONE,
    });
  } catch (error) { commit(); throw error; }
  return {
    commit,
    async rollback() {
      if (finished) return;
      if (!artifactsRestored) { replace(copies.filter(copy => copy.existed)); artifactsRestored = true; }
      for (const copy of copies) if (!copy.existed) fs.rmSync(copy.currentPath, { recursive: true, force: true });
      const restored = await shell.exec(branch
        ? `git checkout -f -B ${shellQuote(branch)} ${sha}` : `git checkout -f --detach ${sha}`, options);
      if (restored.exitCode !== 0) throw new Error('CDS 产物已恢复，但源码恢复失败；已停止更新，请检查控制面工作树。');
      const rendered = await shell.exec('./exec_cds.sh nginx-render', { cwd: cdsDir, timeout: 15_000 });
      if (rendered.exitCode !== 0) throw new Error('CDS 原版本已恢复，但入口配置恢复失败；请检查 CDS 系统日志。');
      commit();
    },
  };
}
