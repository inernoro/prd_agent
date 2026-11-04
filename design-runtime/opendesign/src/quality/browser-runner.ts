import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { chromium } from 'playwright-core';

import { AgentWorkspaceRuntimeError } from '../errors.js';
import {
  BROWSER_CHECK_TIMEOUT_MS,
  type BrowserQualityWorkerJob,
  type BrowserQualityWorkerResult,
} from './browser-contract.js';

export interface BrowserQualityRunner {
  run(job: BrowserQualityWorkerJob, signal: AbortSignal): Promise<BrowserQualityWorkerResult>;
}

export interface BrowserQualityProbe {
  ready: boolean;
  executablePath: string;
  observation: string;
}

export interface BrowserQualityProbeOptions {
  env?: NodeJS.ProcessEnv;
  engineHome?: string;
  engineUid?: number;
  engineGid?: number;
}

export function resolveBrowserExecutablePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DESIGN_RUNTIME_BROWSER_EXECUTABLE_PATH?.trim() || chromium.executablePath();
}

function directoryWritableBy(stat: fs.Stats, uid?: number, gid?: number): boolean {
  if (uid === undefined) return true;
  if (stat.uid === uid) return (stat.mode & 0o200) !== 0;
  if (gid !== undefined && stat.gid === gid) return (stat.mode & 0o020) !== 0;
  return (stat.mode & 0o002) !== 0;
}

export function probeBrowserQuality(options: BrowserQualityProbeOptions = {}): BrowserQualityProbe {
  const env = options.env ?? process.env;
  const executablePath = resolveBrowserExecutablePath(env);
  const engineHome = options.engineHome ?? (env.DESIGN_RUNTIME_ENGINE_HOME?.trim() || '/home/open-design');
  const executableReady = fs.existsSync(executablePath);
  let homeReady = false;
  try {
    const stat = fs.statSync(engineHome);
    homeReady = stat.isDirectory() && directoryWritableBy(stat, options.engineUid, options.engineGid);
  } catch {
    homeReady = false;
  }
  const ready = executableReady && homeReady;
  return {
    ready,
    executablePath,
    observation: !executableReady
      ? 'Playwright Chromium executable is missing'
      : !homeReady
        ? `Browser HOME is missing or not writable by the engine identity: ${engineHome}`
        : `${path.basename(executablePath)} with writable browser HOME`,
  };
}

export function summarizeBrowserWorkerFailure(error: unknown, maxLength = 300): string {
  const message = error instanceof Error ? error.message : String(error || 'unknown');
  const lines = message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const diagnostic = lines.find((line) => /\[pid=.*\]\[err\]/.test(line))
    ?? lines.find((line) => /ERROR|FATAL|SIG[A-Z]+|permission|denied|timeout/i.test(line));
  const exit = lines.find((line) => /process did exit|exitCode=|signal=/.test(line));
  return [...new Set([lines[0] || 'unknown', diagnostic, exit].filter((line): line is string => Boolean(line)))]
    .join(' | ')
    .slice(0, maxLength);
}

export class SubprocessBrowserQualityRunner implements BrowserQualityRunner {
  constructor(
    private readonly uid?: number,
    private readonly gid?: number,
    private readonly home = '/app',
  ) {}

  async run(job: BrowserQualityWorkerJob, signal: AbortSignal): Promise<BrowserQualityWorkerResult> {
    return new Promise<BrowserQualityWorkerResult>((resolve, reject) => {
      const worker = fork(new URL('./browser-worker.js', import.meta.url), [], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: {
          PATH: process.env.PATH || '',
          HOME: this.home,
          ...(process.env.PLAYWRIGHT_BROWSERS_PATH
            ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }
            : {}),
          ...(process.env.DESIGN_RUNTIME_BROWSER_EXECUTABLE_PATH
            ? { DESIGN_RUNTIME_BROWSER_EXECUTABLE_PATH: process.env.DESIGN_RUNTIME_BROWSER_EXECUTABLE_PATH }
            : {}),
          MAP_BROWSER_QUALITY_WORKER: '1',
        },
        ...(typeof process.getuid === 'function' && process.getuid() === 0 && this.uid !== undefined
          ? { uid: this.uid, gid: this.gid ?? this.uid }
          : {}),
      });
      let stderr = '';
      let settled = false;
      worker.stderr?.on('data', (chunk) => {
        if (stderr.length < 4_096) stderr += String(chunk).slice(0, 4_096 - stderr.length);
      });
      const finish = (error?: Error, result?: BrowserQualityWorkerResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', aborted);
        if (worker.connected) worker.disconnect();
        if (!worker.killed) worker.kill('SIGKILL');
        if (error) reject(error);
        else resolve(result!);
      };
      const aborted = () => finish(new DOMException('Browser quality check aborted', 'AbortError'));
      const timeout = setTimeout(() => finish(new AgentWorkspaceRuntimeError(
        'browser_quality_unavailable',
        `Isolated browser quality worker exceeded ${BROWSER_CHECK_TIMEOUT_MS}ms`,
        true,
      )), BROWSER_CHECK_TIMEOUT_MS);
      signal.addEventListener('abort', aborted, { once: true });
      worker.once('error', (error) => finish(new AgentWorkspaceRuntimeError(
        'browser_quality_unavailable',
        `Isolated browser quality worker could not start: ${error.message.slice(0, 200)}`,
        true,
      )));
      worker.once('exit', (code, exitSignal) => {
        if (!settled) finish(new AgentWorkspaceRuntimeError(
          'browser_quality_unavailable',
          `Isolated browser quality worker exited before returning evidence (code=${code ?? 'none'}, signal=${exitSignal ?? 'none'}, observation=${stderr.trim().slice(0, 200) || 'none'})`,
          true,
        ));
      });
      worker.on('message', (message: unknown) => {
        const response = message as { ok?: boolean; result?: BrowserQualityWorkerResult; error?: string };
        if (response.ok && response.result) finish(undefined, response.result);
        else finish(new AgentWorkspaceRuntimeError(
          'browser_quality_unavailable',
          `Isolated browser quality check failed: ${(response.error || 'unknown').slice(0, 240)}`,
          true,
        ));
      });
      if (signal.aborted) aborted();
      else worker.send(job);
    });
  }
}
