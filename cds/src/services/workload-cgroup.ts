/**
 * 托管工作负载的 cgroup 归属（2026-09-08 宿主过载复盘）。
 *
 * 病根：CDS 自身进程（master / forwarder）和它拉起的几十个业务容器、构建作业
 * 在同一台机器上按 Linux 公平调度同权抢 CPU 与磁盘 IO。18 核宿主 load 长期在
 * 20 以上时，控制面和被它管理的东西一起饿死——用户看到的就是「CDS 打不开」。
 *
 * 05-28 用户明确不给容器设任何 --cpus / --memory 上限，本模块**不违反**这条：
 * 它只改「抢不过时谁先拿到」，不改「最多能拿多少」。做法是把 CDS 拉起的每个
 * 容器（app / infra / 一次性 job）都挂到同一个低权重 slice 下：
 *
 *   system.slice
 *   ├── cds-master.service        CPUWeight=1000  IOWeight=1000
 *   ├── cds-forwarder.service     CPUWeight=1000  IOWeight=1000
 *   ├── docker.service            默认 100
 *   └── system-cdsworkloads.slice CPUWeight=100   IOWeight=100   ← 所有托管容器
 *
 * 空闲时容器照样用满整机；争抢时 CDS 进程按权重先拿。
 *
 * docker 的 cgroup driver 决定 `--cgroup-parent` 的写法与效果：
 *   - systemd：传 slice 名，systemd 按 /etc/systemd/system/<slice> 的权重接管，权重生效。
 *   - cgroupfs：只能传路径，权重没人管（仅归类），启动日志与 healthz 会明说。
 * 探测走一次 `docker info`，进程生命周期内不变。
 */
import type { IShellExecutor } from '../types.js';
import { isPreviewInstance } from './preview-instance.js';

export const DEFAULT_WORKLOAD_SLICE = 'system-cdsworkloads.slice';

export type DockerCgroupDriver = 'systemd' | 'cgroupfs' | 'unknown';

export interface WorkloadCgroupStatus {
  /** 是否会给托管容器追加 --cgroup-parent */
  enabled: boolean;
  /** 实际传给 docker 的 --cgroup-parent 值；未启用为 null */
  parent: string | null;
  driver: DockerCgroupDriver;
  /** 权重是否由 systemd 接管（只有 systemd driver + slice 才算真隔离） */
  weightManaged: boolean;
  reason: string;
}

const UNRESOLVED: WorkloadCgroupStatus = {
  enabled: false,
  parent: null,
  driver: 'unknown',
  weightManaged: false,
  reason: '尚未探测 docker cgroup driver',
};

let current: WorkloadCgroupStatus = UNRESOLVED;

/** 环境变量口径：`CDS_WORKLOAD_CGROUP_PARENT`，空 = 默认 slice；`0` / `off` / `false` = 关闭。 */
export function workloadCgroupParentFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.CDS_WORKLOAD_CGROUP_PARENT ?? '').trim();
  if (!raw) return DEFAULT_WORKLOAD_SLICE;
  const lower = raw.toLowerCase();
  if (lower === '0' || lower === 'off' || lower === 'false' || lower === 'no') return null;
  return raw;
}

/** 纯函数：给定 driver 与配置值，算出最终归属（便于单测覆盖每个分支）。 */
export function planWorkloadCgroup(
  configured: string | null,
  driver: DockerCgroupDriver,
  opts: { previewInstance?: boolean } = {},
): WorkloadCgroupStatus {
  if (opts.previewInstance) {
    return { enabled: false, parent: null, driver, weightManaged: false, reason: '预览实例不接管宿主 cgroup' };
  }
  if (!configured) {
    return { enabled: false, parent: null, driver, weightManaged: false, reason: 'CDS_WORKLOAD_CGROUP_PARENT 已关闭' };
  }
  if (driver === 'systemd') {
    if (!configured.endsWith('.slice')) {
      return {
        enabled: false, parent: null, driver, weightManaged: false,
        reason: `systemd cgroup driver 要求 --cgroup-parent 是 .slice 名，当前值「${configured}」不合法，已跳过`,
      };
    }
    return { enabled: true, parent: configured, driver, weightManaged: true, reason: `托管容器挂到 ${configured}（systemd 接管权重）` };
  }
  if (driver === 'cgroupfs') {
    // cgroupfs 只认路径；把 slice 名折成一段路径，至少把容器归到一起，方便运维手动设权重。
    const pathName = configured.endsWith('.slice')
      ? `/${configured.slice(0, -'.slice'.length).replace(/^system-/, '')}`
      : (configured.startsWith('/') ? configured : `/${configured}`);
    return {
      enabled: true, parent: pathName, driver, weightManaged: false,
      reason: `docker 用 cgroupfs driver，容器归到 ${pathName} 但权重需运维手动设置（建议切 systemd driver）`,
    };
  }
  return { enabled: false, parent: null, driver, weightManaged: false, reason: '无法识别 docker cgroup driver，未追加 --cgroup-parent' };
}

/** 探测 docker cgroup driver 并固化本进程的归属决策。失败一律安全退化为不追加。 */
export async function resolveWorkloadCgroup(
  shell: IShellExecutor,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorkloadCgroupStatus> {
  const configured = workloadCgroupParentFromEnv(env);
  if (isPreviewInstance(env) || !configured) {
    current = planWorkloadCgroup(configured, 'unknown', { previewInstance: isPreviewInstance(env) });
    return current;
  }
  let driver: DockerCgroupDriver = 'unknown';
  try {
    const r = await shell.exec('docker info -f "{{.CgroupDriver}}"', { timeout: 5000 });
    const out = (r.stdout || '').trim().toLowerCase();
    if (r.exitCode === 0 && (out === 'systemd' || out === 'cgroupfs')) driver = out;
  } catch {
    driver = 'unknown';
  }
  current = planWorkloadCgroup(configured, driver);
  return current;
}

export function getWorkloadCgroupStatus(): WorkloadCgroupStatus {
  return current;
}

/** docker run / create 追加的参数（拼进 shell 字符串用）；未启用时为空数组，调用方无需分支。 */
export function workloadCgroupFlags(): string[] {
  return current.enabled && current.parent ? [`--cgroup-parent ${current.parent}`] : [];
}

/** 同上，argv 形态（spawn / execFile 数组参数用）。 */
export function workloadCgroupArgv(): string[] {
  return current.enabled && current.parent ? ['--cgroup-parent', current.parent] : [];
}

/** 仅供测试：直接钉住决策，或传 null 复位为未探测。 */
export function __setWorkloadCgroupForTest(status: WorkloadCgroupStatus | null): void {
  current = status ?? UNRESOLVED;
}
