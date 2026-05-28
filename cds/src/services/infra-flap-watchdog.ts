// Infra container flap circuit-breaker
//
// 2026-05-28 prod 事故根因之一:openvisual 的 minio infra 容器 cmd 缺
// `server /data`,启动后立即 exit 0,被 docker `restart=unless-stopped` 无限拉起,
// 5 小时累积 288 次重启,持续 cgroup/network namespace churn 拖垮 host load。
//
// CDS 既有的 crash-loop 检测(index.ts:2040-2130)只覆盖"CDS 主动 docker start"
// 的路径,docker daemon 自己根据 restart policy 的循环不进入那条检测。
// 本 watchdog 补这个盲区:每 60s 扫 docker label=cds.type=infra 的容器,
// 看 RestartCount 是否在快速增长,触发后自动 `docker stop` 打破循环。
//
// stop 而不是 rm:保留容器供 `docker logs` 事后查;`unless-stopped` 见显式
// stop 信号会停下不再拉(这是 docker 的合约)。

import type { IShellExecutor } from '../types.js';
import type { ServerEventLogSink } from './server-event-log-store.js';
import type { StateService } from './state.js';
import { cdsEventsBus } from './cds-events-bus.js';

/**
 * 单容器的重启采样窗口。判定:窗口内 RestartCount delta ≥ threshold → flap。
 *
 * 默认 60s 窗口 + 5 次阈值 ≈ minio 灾难场景(每 60s 重启 1 次)在 5 分钟内
 * 被识别并熔断。可通过 env 调整。
 */
export interface InfraFlapWatchdogOptions {
  /** 采样间隔(ms),默认 60s */
  tickIntervalMs?: number;
  /** 触发熔断的 RestartCount delta 阈值(在 windowMs 内),默认 5 */
  restartDeltaThreshold?: number;
  /** 滑动窗口长度(ms),默认 5 分钟 */
  windowMs?: number;
  /** 测试注入:override 当前时间 */
  now?: () => number;
}

export interface FlapSample {
  containerId: string;
  containerName: string;
  restartCount: number;
  status: string;
  ts: number;
}

export interface InfraFlapWatchdogDeps {
  shell: IShellExecutor;
  serverEventLogStore?: ServerEventLogSink | null;
  stateService?: Pick<StateService, 'getInfraServices' | 'updateInfraService'> | null;
}

interface ContainerHistory {
  samples: FlapSample[];
  /** 已经熔断过一次后,避免重复 stop */
  trippedAt?: number;
}

export class InfraFlapWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly tickIntervalMs: number;
  private readonly restartDeltaThreshold: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly history = new Map<string, ContainerHistory>();
  private running = false;

  constructor(
    private readonly deps: InfraFlapWatchdogDeps,
    options?: InfraFlapWatchdogOptions,
  ) {
    this.tickIntervalMs = Math.max(5_000, options?.tickIntervalMs ?? 60_000);
    this.restartDeltaThreshold = Math.max(2, options?.restartDeltaThreshold ?? 5);
    this.windowMs = Math.max(60_000, options?.windowMs ?? 300_000);
    this.now = options?.now || (() => Date.now());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error('[infra-flap-watchdog] tick failed:', (err as Error).message);
      });
    }, this.tickIntervalMs);
    if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
      (this.timer as { unref?: () => void }).unref!();
    }
    console.log(
      `[infra-flap-watchdog] started (tick=${Math.round(this.tickIntervalMs / 1000)}s `
      + `threshold=${this.restartDeltaThreshold} window=${Math.round(this.windowMs / 1000)}s)`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 暴露给测试 */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const samples = await this.collectSamples();
      const tripped = this.evaluateSamples(samples);
      for (const sample of tripped) {
        await this.tripCircuitBreaker(sample);
      }
    } finally {
      this.running = false;
    }
  }

  private async collectSamples(): Promise<FlapSample[]> {
    // 一次性查询所有 CDS 管理的 infra 容器的 RestartCount + Status
    // format 用 `|` 分隔避免和容器名里的 `-` 冲突
    const cmd =
      `docker ps -a --filter "label=cds.managed=true" --filter "label=cds.type=infra" `
      + `--format '{{.ID}}|{{.Names}}' 2>/dev/null`;
    const list = await this.deps.shell.exec(cmd);
    if (list.exitCode !== 0 || !list.stdout.trim()) return [];

    const samples: FlapSample[] = [];
    const ts = this.now();
    const ids = list.stdout
      .trim()
      .split('\n')
      .map((line) => line.split('|'))
      .filter((parts) => parts.length === 2);

    if (ids.length === 0) return [];

    // 批量 inspect — 单个 docker inspect 调用拿所有的 RestartCount + State.Status
    const inspectCmd =
      `docker inspect --format '{{.Id}}|{{.Name}}|{{.RestartCount}}|{{.State.Status}}' `
      + ids.map((p) => p[0]).join(' ');
    const inspect = await this.deps.shell.exec(inspectCmd);
    if (inspect.exitCode !== 0) return [];

    for (const line of inspect.stdout.trim().split('\n')) {
      const parts = line.split('|');
      if (parts.length < 4) continue;
      const [containerId, rawName, restartStr, status] = parts;
      const restartCount = Number(restartStr);
      if (!Number.isFinite(restartCount)) continue;
      // docker inspect 的 .Name 是 "/cds-foo",前面有斜杠;去掉
      const containerName = rawName.startsWith('/') ? rawName.slice(1) : rawName;
      samples.push({ containerId, containerName, restartCount, status, ts });
    }
    return samples;
  }

  /** 将本轮 sample 与历史窗口比对,返回需要熔断的 sample 列表 */
  evaluateSamples(samples: FlapSample[]): FlapSample[] {
    const tripped: FlapSample[] = [];
    const cutoff = this.now() - this.windowMs;

    // 清掉已经从 docker 消失的容器历史(rm 后不再追踪)
    const activeIds = new Set(samples.map((s) => s.containerId));
    for (const id of [...this.history.keys()]) {
      if (!activeIds.has(id)) this.history.delete(id);
    }

    for (const sample of samples) {
      const hist = this.history.get(sample.containerId) || { samples: [] };
      // 移除窗口外的旧 sample
      hist.samples = hist.samples.filter((s) => s.ts >= cutoff);
      hist.samples.push(sample);
      this.history.set(sample.containerId, hist);

      // 已熔断过的,跳过(避免对已 stopped 容器再次 stop)
      if (hist.trippedAt) continue;

      // 至少 2 个 sample 才能算 delta
      if (hist.samples.length < 2) continue;
      const oldest = hist.samples[0];
      const delta = sample.restartCount - oldest.restartCount;
      if (delta >= this.restartDeltaThreshold) {
        hist.trippedAt = this.now();
        tripped.push(sample);
      }
    }
    return tripped;
  }

  private async tripCircuitBreaker(sample: FlapSample): Promise<void> {
    const message =
      `infra 容器 ${sample.containerName} 触发 flap 熔断:`
      + `${this.windowMs / 1000}s 内 RestartCount 增量 ≥ ${this.restartDeltaThreshold}。`
      + `自动 docker stop 打破循环,容器保留供 docker logs 排查。`;

    // 1) docker stop(unless-stopped 见 stop 信号会停下不再拉)
    const stopResult = await this.deps.shell.exec(`docker stop --timeout 5 ${sample.containerName}`);

    // 2) 写审计事件
    this.deps.serverEventLogStore?.record({
      category: 'container',
      severity: 'error',
      source: 'infra-flap-watchdog',
      action: 'infra.flap.circuit-breaker',
      message,
      containerName: sample.containerName,
      details: {
        containerId: sample.containerId,
        restartCount: sample.restartCount,
        thresholdDelta: this.restartDeltaThreshold,
        windowSeconds: Math.round(this.windowMs / 1000),
        stopExitCode: stopResult.exitCode,
        stopStderr: stopResult.stderr?.slice(0, 200) || '',
      },
    });

    // 3) 同步 InfraService 状态 → error,前端能看到
    if (this.deps.stateService) {
      try {
        const all = this.deps.stateService.getInfraServices() as Array<{ id: string; projectId: string; containerName: string }>;
        const svc = all.find((s) => s.containerName === sample.containerName);
        if (svc) {
          this.deps.stateService.updateInfraService(
            svc.id,
            { status: 'error', errorMessage: message },
            svc.projectId,
          );
        }
      } catch (err) {
        console.error('[infra-flap-watchdog] failed to update state:', (err as Error).message);
      }
    }

    // 4) bus 广播一条 toast 给前端
    cdsEventsBus.publish('infra.flap.circuit-breaker', {
      containerName: sample.containerName,
      restartCount: sample.restartCount,
      thresholdDelta: this.restartDeltaThreshold,
      windowSeconds: Math.round(this.windowMs / 1000),
      message,
    });

    console.warn(`[infra-flap-watchdog] tripped: ${message}`);
  }
}
