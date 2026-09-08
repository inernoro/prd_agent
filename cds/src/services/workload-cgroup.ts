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
import fs from 'node:fs';
import type { IShellExecutor } from '../types.js';
import { isPreviewInstance } from './preview-instance.js';

export const DEFAULT_WORKLOAD_SLICE = 'system-cdsworkloads.slice';

export type DockerCgroupDriver = 'systemd' | 'cgroupfs' | 'unknown';

export interface WorkloadCgroupStatus {
  /** 是否会给托管容器追加 --cgroup-parent */
  enabled: boolean;
  /**
   * 归组只对**此后新建**的容器生效：`--cgroup-parent` 是 docker create/run 时的参数，
   * 升级前就在跑的容器（尤其长命的共享基础设施）不会自己迁进来，要等下次重建。
   * 所以哪怕 weightManaged 为真，覆盖面也不是全量——不说清楚就是又一次谎报
   * （Codex PR #1516 十二轮 P1）。真要全量得巡检每个容器的实际归属再逐个重建，
   * 那是运维动作，不在本批范围。
   */
  coverage: 'new-containers-only';
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
  coverage: 'new-containers-only',
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

/**
 * 控制面被提权的唯一来源是 systemd 单元里的 CPUWeight/IOWeight/Nice，而 CDS 有好几条
 * 启动路径都不经过那份单元：executor 接入时以后台进程拉起、standalone/scheduler 也能
 * 用后台或前台方式直接跑 node。按运行模式猜会漏掉后两类，继续按模式打补丁只会越补越窄
 * （Codex PR #1516 十轮 P2）。改成量真实的那个值：读进程自己的 cgroup 归属，落在控制面
 * 单元下才算被提权。
 *
 * 兼容 cgroup v2（`0::/system.slice/cds-master.service`）与 v1（每行一个子系统）。
 */
export const CONTROL_PLANE_UNITS = ['cds-master.service', 'cds-forwarder.service'] as const;

export function isControlPlanePrioritized(selfCgroup: string | null): boolean {
  if (!selfCgroup) return false;
  return CONTROL_PLANE_UNITS.some((unit) => selfCgroup.includes(unit));
}

/** 读 /proc/self/cgroup；读不到（非 Linux、被裁剪的容器）返回 null，按未提权处理。 */
export function readSelfCgroup(): string | null {
  try {
    return fs.readFileSync('/proc/self/cgroup', 'utf8');
  } catch {
    return null;
  }
}

/**
 * docker `--cgroup-parent` 允许的字符集。这个值来自运维配置的
 * `CDS_WORKLOAD_CGROUP_PARENT`，会被拼进宿主 shell 的 docker 命令行——
 * 一个空格就能让此后所有部署的命令行错位，一个分号就是宿主上的另一条命令
 * （Codex PR #1516 六轮 P2）。所以先按字符集拒收，再在拼串时加引号，两道都要。
 * systemd slice 名与 cgroupfs 路径都落在这个集合里：字母数字加 `.-_/`。
 */
const CGROUP_PARENT_PATTERN = /^[A-Za-z0-9._\/-]+$/;

/** 拼进 shell 字符串前的单引号包裹（值里的单引号按 POSIX 方式转义）。 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 纯函数：给定 driver 与配置值，算出最终归属（便于单测覆盖每个分支）。 */
export function planWorkloadCgroup(
  configured: string | null,
  driver: DockerCgroupDriver,
  opts: { previewInstance?: boolean; controlPlanePrioritized?: boolean } = {},
): WorkloadCgroupStatus {
  if (opts.previewInstance) {
    return { enabled: false, parent: null, driver, weightManaged: false, coverage: 'new-containers-only', reason: '预览实例不接管宿主 cgroup' };
  }
  if (!configured) {
    return { enabled: false, parent: null, driver, weightManaged: false, coverage: 'new-containers-only', reason: 'CDS_WORKLOAD_CGROUP_PARENT 已关闭' };
  }
  if (!CGROUP_PARENT_PATTERN.test(configured)) {
    return {
      enabled: false, parent: null, driver, weightManaged: false, coverage: 'new-containers-only',
      reason: `CDS_WORKLOAD_CGROUP_PARENT「${configured}」含非法字符（只允许字母数字与 . _ - /），已跳过`,
    };
  }
  if (driver === 'systemd') {
    if (!configured.endsWith('.slice')) {
      return {
        enabled: false, parent: null, driver, weightManaged: false, coverage: 'new-containers-only',
        reason: `systemd cgroup driver 要求 --cgroup-parent 是 .slice 名，当前值「${configured}」不合法，已跳过`,
      };
    }
    // 只把容器归进低权重 slice 还不够：1000:100 这个保护比要成立，控制面进程自己
    // 也得跑在带 CPUWeight/IOWeight 的 systemd 单元里。executor 是 `nohup node`
    // 起的，没有那份单元，于是容器归了组、API 仍是默认权重——此时报 weightManaged
    // 就是谎报（Codex PR #1516 九轮 P2）。归组仍然保留（容器彼此归到一起，运维
    // 给该宿主装上单元或手动设权重后即刻生效），但状态如实说没保护。
    if (opts.controlPlanePrioritized === false) {
      return {
        enabled: true, parent: configured, driver, weightManaged: false, coverage: 'new-containers-only',
        reason: `托管容器已挂到 ${configured}，但本进程不在控制面 systemd 单元（${CONTROL_PLANE_UNITS.join(' / ')}）下，拿不到 CPUWeight/IOWeight 提权：容器已归组，控制面未受保护`,
      };
    }
    return { enabled: true, parent: configured, driver, weightManaged: true, coverage: 'new-containers-only', reason: `托管容器挂到 ${configured}（systemd 接管权重）；仅对此后新建的容器生效，升级前就在跑的容器要等下次重建才进组` };
  }
  if (driver === 'cgroupfs') {
    // cgroupfs 只认路径；把 slice 名折成一段路径，至少把容器归到一起，方便运维手动设权重。
    const pathName = configured.endsWith('.slice')
      ? `/${configured.slice(0, -'.slice'.length).replace(/^system-/, '')}`
      : (configured.startsWith('/') ? configured : `/${configured}`);
    return {
      enabled: true, parent: pathName, driver, weightManaged: false, coverage: 'new-containers-only',
      reason: `docker 用 cgroupfs driver，容器归到 ${pathName} 但权重需运维手动设置（建议切 systemd driver）`,
    };
  }
  return { enabled: false, parent: null, driver, weightManaged: false, coverage: 'new-containers-only', reason: '无法识别 docker cgroup driver，未追加 --cgroup-parent' };
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
  // 量真实值而不是按运行模式猜：好几条启动路径（executor 接入、后台/前台直接跑 node）
  // 都不经过控制面 systemd 单元，只有落在那份单元下才真的有 CPUWeight/IOWeight 提权。
  const controlPlanePrioritized = isControlPlanePrioritized(readSelfCgroup());
  current = planWorkloadCgroup(configured, driver, { controlPlanePrioritized });
  return current;
}

export function getWorkloadCgroupStatus(): WorkloadCgroupStatus {
  return current;
}

/** docker run / create 追加的参数（拼进 shell 字符串用）；未启用时为空数组，调用方无需分支。 */
export function workloadCgroupFlags(): string[] {
  return current.enabled && current.parent ? [`--cgroup-parent ${shellQuote(current.parent)}`] : [];
}

/** 同上，argv 形态（spawn / execFile 数组参数用）。 */
export function workloadCgroupArgv(): string[] {
  return current.enabled && current.parent ? ['--cgroup-parent', current.parent] : [];
}

/** 仅供测试：直接钉住决策，或传 null 复位为未探测。 */
export function __setWorkloadCgroupForTest(status: WorkloadCgroupStatus | null): void {
  current = status ?? UNRESOLVED;
}
