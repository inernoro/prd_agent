import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { HostCapacityObservationService } from './host-capacity-observation.js';

export interface CapacitySamplingStatus {
  enabled: boolean; running: boolean; external: boolean; lastStartedAt: string | null;
  lastFinishedAt: string | null; outcome: 'never' | 'collected' | 'unknown';
  sources: Record<string, string>; unavailableSources: string[];
  coverage: string;
}
const HOUR = 3600_000;
const related = (a: string, b: string) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);

/** A trusted read-only command in its own process group; its children share the
 * same cancellation budget. No shell, inherited application secrets or pruning. */
export function runCapacityProbe(argv: string[], signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', argv, { detached: true, stdio: 'ignore',
      env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8' } });
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
    const abort = () => kill();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(kill, 55_000);
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    child.once('error', error => { finish(); reject(error); });
    child.once('close', code => { finish(); code === null ? reject(new Error('probe-unconfirmed')) : resolve(code); });
    if (signal.aborted) kill();
  });
}

export class HostCapacitySamplingService {
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private updating = false;
  private active = false;
  private status: CapacitySamplingStatus;
  constructor(private readonly options: {
    enabled: boolean; external: boolean; stateDir: string; roots: Record<string, string>;
    observation: HostCapacityObservationService; persist: (enabled: boolean) => Promise<void>;
    run?: typeof runCapacityProbe; now?: () => number;
  }) {
    this.status = { enabled: options.enabled && !options.external, external: options.external, running: false,
      lastStartedAt: null, lastFinishedAt: null, outcome: 'never', sources: {}, unavailableSources: [],
      coverage: '仅盘点已列出的 CDS 目录及其所在文件系统；业务数据库、Docker 共享层及远端发布目录未在此逐项盘点，来源不能相加作为整盘占用。' };
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  getStatus(): CapacitySamplingStatus { return structuredClone(this.status); }
  start(): void {
    if (!this.status.enabled) return;
    this.active = true;
    if (this.controller || this.timer) return;
    this.options.observation.configure(path.join(this.options.stateDir, 'latest.json'), os.hostname());
    void this.collect(this.generation);
  }
  stop(): void {
    this.active = false; this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
  }
  async setEnabled(enabled: boolean): Promise<void> {
    if (this.status.external) throw new Error('external-report-configured');
    if (this.updating) throw new Error('configuration-in-progress');
    this.updating = true;
    const generation = this.generation;
    try {
      await this.options.persist(enabled);
      this.status.enabled = enabled;
      if (generation !== this.generation) return;
      this.stop();
      if (enabled) this.start();
      else this.options.observation.configure();
    } finally { this.updating = false; }
  }
  requestSample(): void {
    if (!this.status.enabled || this.updating || this.controller) throw new Error('sampling-unavailable');
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    void this.collect(this.generation);
  }
  private async collect(generation: number): Promise<void> {
    if (!this.active || !this.status.enabled || this.controller || generation !== this.generation) return;
    const controller = new AbortController(); this.controller = controller;
    this.status.running = true; this.status.lastStartedAt = new Date(this.now()).toISOString();
    try {
      const state = path.resolve(this.options.stateDir);
      const sources: Record<string, string> = {}, unavailable: string[] = [];
      for (const [name, candidate] of Object.entries(this.options.roots)) {
        try {
          const real = await fs.realpath(candidate), st = await fs.stat(real);
          if (!st.isDirectory() || related(real, state) || Object.values(sources).some(p => related(real, p))) throw new Error('overlap');
          sources[name] = real;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          unavailable.push(name);
        }
      }
      if (controller.signal.aborted || generation !== this.generation) return;
      this.status.sources = sources; this.status.unavailableSources = unavailable;
      if (!Object.keys(sources).length) throw new Error('no-known-sources');
      const latest = path.join(state, 'latest.json');
      const before = await fs.lstat(latest).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      const startedAt = this.now();
      const argv = [fileURLToPath(new URL('./host-capacity-probe.py', import.meta.url)), '--state-dir', state,
        ...Object.entries(sources).flatMap(([name, root]) => ['--source', `${name}=${root}`])];
      const code = await (this.options.run ?? runCapacityProbe)(argv, controller.signal);
      if (controller.signal.aborted || generation !== this.generation) return;
      if (![0, 1, 2, 3].includes(code)) throw new Error('probe-unconfirmed');
      const after = await fs.lstat(latest);
      if (!after.isFile() || after.nlink !== 1 || (before && before.dev === after.dev && before.ino === after.ino))
        throw new Error('current-run-report-unconfirmed');
      await this.options.observation.refresh(startedAt);
      this.status.outcome = this.options.observation.getSnapshot().sampledAt ? 'collected' : 'unknown';
    } catch {
      if (generation === this.generation) {
        this.status.outcome = 'unknown';
        this.options.observation.markUnavailable('容量采集失败，增长与安全余量未知；请检查采样依赖与目录权限');
      }
    } finally {
      if (this.controller === controller) { this.controller = undefined; this.status.running = false; }
      if (generation === this.generation && this.active && this.status.enabled) {
        this.status.lastFinishedAt = new Date(this.now()).toISOString();
        this.timer = setTimeout(() => { this.timer = undefined; void this.collect(generation); }, HOUR);
      } else if (this.active && this.status.enabled && !this.status.external) this.start();
    }
  }
}
