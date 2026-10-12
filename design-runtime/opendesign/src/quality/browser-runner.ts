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

export function resolveBrowserExecutablePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DESIGN_RUNTIME_BROWSER_EXECUTABLE_PATH?.trim() || chromium.executablePath();
}

export function probeBrowserQuality(env: NodeJS.ProcessEnv = process.env): BrowserQualityProbe {
  const executablePath = resolveBrowserExecutablePath(env);
  const ready = fs.existsSync(executablePath);
  return {
    ready,
    executablePath,
    observation: ready ? path.basename(executablePath) : 'Playwright Chromium executable is missing',
  };
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
