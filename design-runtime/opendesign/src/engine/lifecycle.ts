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
  /** 任务目录不许包含的路径（服务代码、只读设计系统等）；缺省只保护当前工作目录。 */
  protectedPaths?: string[];
}

/**
 * 这些目录本身绝不许被当成「任务目录」递归清空：服务以 root 运行，配置写错一个字就会删掉
 * 整个容器或挂进来的数据（Codex P2，2026-09-24）。只拦「就是这个目录」，它们的子目录可以用。
 */
const BROAD_DIRECTORIES = new Set([
  '/', '/app', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib64', '/media', '/mnt',
  '/opt', '/proc', '/root', '/run', '/sbin', '/srv', '/sys', '/tmp', '/usr', '/var', '/var/lib',
]);

function realOrResolved(directory: string): string {
  const resolved = path.resolve(directory);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function isSameOrInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * 在任何递归清空发生之前核对任务目录：必须是绝对路径、不是根或宽泛的系统目录、四个目录互不相同
 * 也互不包含、不包含服务自己的代码与只读资源。任一不满足就拒绝启动并说清是哪一个——
 * 宁可起不来，也不先删了再发现配错了。
 */
export function assertWipeableDirectories(directories: EngineDirectories, protectedPaths: string[] = [process.cwd()]): void {
  const entries = Object.entries(directories) as Array<[keyof EngineDirectories, string]>;
  const resolved: Array<[string, string]> = [];
  for (const [name, raw] of entries) {
    if (!raw || !path.isAbsolute(raw)) {
      throw new Error(`任务目录 ${name} 必须是绝对路径，当前是「${raw}」`);
    }
    const real = realOrResolved(raw);
    if (BROAD_DIRECTORIES.has(path.resolve(raw)) || BROAD_DIRECTORIES.has(real)) {
      throw new Error(`任务目录 ${name}=「${raw}」指向根或宽泛的系统目录，每轮任务后会被清空，已拒绝启动`);
    }
    resolved.push([name, real]);
  }
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      const [a, aPath] = resolved[i];
      const [b, bPath] = resolved[j];
      if (isSameOrInside(aPath, bPath) || isSameOrInside(bPath, aPath)) {
        throw new Error(`任务目录 ${a} 与 ${b} 相同或互相包含（${aPath} / ${bPath}），清空一个会连带另一个，已拒绝启动`);
      }
    }
  }
  for (const guarded of protectedPaths.filter(Boolean)) {
    const guardedReal = realOrResolved(guarded);
    for (const [name, dirPath] of resolved) {
      if (isSameOrInside(guardedReal, dirPath)) {
        throw new Error(`任务目录 ${name}=「${dirPath}」包含服务自己要读的「${guardedReal}」，清空会删掉它，已拒绝启动`);
      }
    }
  }
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
    assertWipeableDirectories(options.directories, options.protectedPaths);
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
