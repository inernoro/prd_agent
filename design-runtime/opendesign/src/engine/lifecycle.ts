// 引擎生命周期：隔离方案 A 的落点。
//
// 每实例同一时间只跑一个任务；任务结束（成功、失败、取消、超时）后一律走 reset()：
//   停掉 daemon（连同它拉起的 Codex 进程组）→ 清空工作目录、OpenDesign 数据目录、平台模板拷贝、
//   产物导出目录 → 核对四个目录确实为空 → 以一组新令牌重新拉起 daemon → 健康检查通过。
// 核对不通过就不放行下一个任务：宁可暂停接单，也不让下一个任务读到上一个任务的文件或票据。
//
// daemon 自己意外退出时同样走 reset()（由 tasks.ts 触发），并把这次退出记下来，
// 能力接口据此如实报告，而不是在下一次健康探测碰巧成功之后就把它忘掉。
import fs from 'node:fs';
import path from 'node:path';

import { AgentWorkspaceRuntimeError } from '../errors.js';
import { OpenDesignClient, probeDaemonHealth, type DaemonHealth } from './client.js';
import type { DaemonExit, EngineDaemon } from './daemon.js';

export interface EngineDirectories {
  workspaceDir: string;
  dataDir: string;
  templatesDir: string;
  outputDir: string;
}

export interface EngineLifecycleOptions {
  daemon: EngineDaemon;
  directories: EngineDirectories;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  /** 以 root 运行时，把引擎要写的目录交还给引擎用户。 */
  engineUid?: number;
  engineGid?: number;
  /** 重新拉起后等待健康的上限（秒）。 */
  startTimeoutSeconds?: number;
}

/** 清空一个目录里的全部内容，目录本身保留。 */
function wipeDirectoryContents(directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
  for (const name of fs.readdirSync(directory)) {
    fs.rmSync(path.join(directory, name), { recursive: true, force: true });
  }
}

export class EngineLifecycle {
  private readonly fetchImpl: typeof fetch;
  private unexpectedExits: DaemonExit[] = [];

  constructor(private readonly options: EngineLifecycleOptions) {
    this.fetchImpl = options.fetchImpl || fetch;
    options.daemon.onUnexpectedExit((exit) => {
      this.unexpectedExits = [...this.unexpectedExits, exit].slice(-20);
    });
  }

  get daemon(): EngineDaemon {
    return this.options.daemon;
  }

  onUnexpectedExit(listener: (exit: DaemonExit) => void): void {
    this.options.daemon.onUnexpectedExit(listener);
  }

  /** 最近一次意外退出，以及最近十分钟内意外退出了几次（能力接口据此决定「等」还是「查」）。 */
  unexpectedExitSummary(now = Date.now()): { last: DaemonExit | null; recentCount: number } {
    const recent = this.unexpectedExits.filter((exit) => now - Date.parse(exit.at) <= 10 * 60_000);
    return { last: this.unexpectedExits.at(-1) ?? null, recentCount: recent.length };
  }

  /** 列出仍未清空的目录；全部为空返回空数组。 */
  private residualDirectories(): string[] {
    const { workspaceDir, dataDir, templatesDir, outputDir } = this.options.directories;
    return [workspaceDir, dataDir, templatesDir, outputDir].filter((directory) => {
      try {
        return fs.readdirSync(directory).length > 0;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ENOENT';
      }
    });
  }

  async reset(): Promise<void> {
    await this.options.daemon.stop();
    const { workspaceDir, dataDir, templatesDir, outputDir } = this.options.directories;
    const failures: string[] = [];
    for (const directory of [workspaceDir, dataDir, templatesDir, outputDir]) {
      try {
        wipeDirectoryContents(directory);
      } catch (error) {
        failures.push(`${directory}: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`);
      }
    }
    const residual = this.residualDirectories();
    if (failures.length > 0 || residual.length > 0) {
      throw new AgentWorkspaceRuntimeError(
        'workspace_reset_failed',
        'Task directories could not be emptied after the previous task',
        true,
        { failures: failures.slice(0, 8), residualDirectories: residual },
      );
    }
    for (const directory of [workspaceDir, dataDir, templatesDir]) this.chownForEngine(directory);
    const handle = await this.options.daemon.start();
    const client = new OpenDesignClient(this.fetchImpl, handle.baseUrl, handle.apiToken, this.options.pollIntervalMs ?? 500);
    await client.waitForHealth(this.options.startTimeoutSeconds ?? 60);
  }

  /** 实时探测一次 daemon。daemon 没在运行时直接返回不健康，不发请求。 */
  async probe(timeoutMs = 2_000): Promise<DaemonHealth> {
    const handle = this.options.daemon.current();
    if (!handle) return { ok: false, version: null, observation: 'engine process is not running' };
    return probeDaemonHealth(this.fetchImpl, handle.baseUrl, handle.apiToken, timeoutMs);
  }

  private chownForEngine(directory: string): void {
    const uid = this.options.engineUid;
    if (uid === undefined || typeof process.getuid !== 'function' || process.getuid() !== 0) return;
    fs.chownSync(directory, uid, this.options.engineGid ?? uid);
  }
}
