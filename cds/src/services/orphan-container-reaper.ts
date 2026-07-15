/**
 * 孤儿容器收割器（Orphan Container Reaper，2026-07-15）。
 *
 * 背景（用户实锤 + 24h 日志取证）：删除的项目 / 分支，其 infra / app 容器
 * 会永远留在宿主上——project DELETE 明确不碰容器，startup reconcile 只对孤儿
 * 记一条 warn（单日取证：68 个孤儿 app 容器，最早是 5 月删除的测试分支），
 * infra 孤儿甚至只有 console.warn。结果是容器数持续膨胀（perf-health 的
 * too-many-containers 告警），CPU 被僵尸容器吃掉。
 *
 * 原则（对账收敛，不再指望命令式级联做全对）：
 *   docker 里存在、但 state 里没有 owner 的 cds-managed 容器 = 孤儿 → 停掉。
 *   删除操作的快速级联仍然做（routes 层），本收割器是最终一致性兜底：
 *   无论哪条删除路径漏了、崩了、半途失败了，最迟一个 sweep 周期后收敛。
 *
 * 安全边界（宁可漏杀不可误杀）：
 *   1. 只碰带 `cds.managed=true` label 的容器（与 discoverInfraContainers /
 *      discoverAppContainersWithStatus 同一口径），宿主上任何非 CDS 容器绝不触碰；
 *   2. docker ps 查询失败（exitCode!=0）→ 本轮直接放弃，绝不在信息不全时动手；
 *   3. state 空库守卫：projects/branches/infraServices 全空时跳过——空库更可能是
 *      state 加载失败或全新安装，而不是"所有容器都成了孤儿"；
 *   4. 默认只 stop 不 rm（用户拍板"至少要停止"）；容器和它的数据卷留给
 *      人工 / 项目删除路径处置；
 *   5. 逃生阀：CDS_ORPHAN_CONTAINER_REAPER=0 整体关闭。
 */
import { createHash } from 'node:crypto';
import type { IShellExecutor, ContainerTeardownTombstone } from '../types.js';
import type { ServerEventLogSink } from './server-event-log-store.js';

/**
 * CDS 实例身份（Codex P1，2026-07-15）：同一宿主可能跑多个 CDS master（生产 +
 * 测试各管各的 repoRoot），docker 只按 cds.managed label 过滤会把**别的实例**的
 * 容器当成本实例的孤儿收割掉。用 repoRoot 哈希作为稳定实例 id：容器创建时打
 * `cds.instance=<id>` label，收割器跳过 label 存在且不等于本实例的容器；
 * 无 label 的历史容器仍在收割范围（升级前的存量孤儿要能被清），随重建自然收敛。
 */
export function computeCdsInstanceId(repoRoot: string): string {
  return createHash('sha1').update(repoRoot || '').digest('hex').slice(0, 12);
}

/** 墓碑处理所需的最小 state 视图（项目删除路由与收割器共用）。 */
export interface TombstoneStateView {
  getContainerTeardownTombstones(): ContainerTeardownTombstone[];
  removeContainerTeardownTombstone(containerName: string): void;
}

/** 收割器状态视图的窄接口（便于单测注入，不拖整个 StateService）。 */
export interface OrphanReaperStateView extends TombstoneStateView {
  getProjects(): Array<{ id: string }>;
  getAllBranches(): Array<{ id: string; services?: Record<string, { containerName?: string }> }>;
  getInfraServices(): Array<{ containerName: string }>;
}

/**
 * 新容器宽限期（Codex P2，2026-07-15）：app 归属判定精确到 branchId/profileId 后，
 * 「分支已建、services 条目尚未落库」的部署中窗口会让新容器短暂无 owner。
 * 创建时间在宽限期内的容器一律不动，跨过宽限期仍无 owner 才算真孤儿。
 * CreatedAt 解析失败同样按「宽限期内」处理（宁漏勿误）。
 */
const ORPHAN_CONTAINER_MIN_AGE_MS = 30 * 60_000;

export interface OrphanContainerAction {
  containerName: string;
  kind: 'infra' | 'app' | 'proxy';
  /** 关联到的 owner 标识（infra 无从考证时为空） */
  ownerHint?: string;
  action: 'stopped' | 'stop-failed' | 'already-stopped';
  detail?: string;
}

export interface OrphanSweepResult {
  skippedReason?: 'disabled' | 'state-empty' | 'docker-query-failed';
  actions: OrphanContainerAction[];
}

export function isOrphanReaperEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.CDS_ORPHAN_CONTAINER_REAPER || '').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off');
}

const quote = (s: string): string => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * 无论 state 里有没有，永远不许收割的系统级容器（自断状态库 = 自杀）。
 * 口径对齐 state.ts 的 classifyInfraScope 已知系统 infra。
 */
const PROTECTED_CONTAINER_NAMES = new Set(['cds-infra-cds-state-mongo']);

interface DiscoveredContainer {
  name: string;
  running: boolean;
  /** docker `{{.CreatedAt}}` 解析结果；解析失败为 NaN（按宽限期内处理）。 */
  createdAtMs: number;
  labels: string;
}

/** docker `{{.CreatedAt}}` 形如 "2026-07-15 09:00:00 +0000 UTC"，去掉尾部时区名后交给 Date.parse。 */
export function parseDockerCreatedAt(raw: string): number {
  const cleaned = (raw || '').replace(/\s+[A-Z]{2,5}$/, '').trim();
  return Date.parse(cleaned);
}

async function listCdsContainers(
  shell: IShellExecutor,
  type: 'infra' | 'app' | 'resource-external-access',
): Promise<DiscoveredContainer[] | null> {
  const result = await shell.exec(
    `docker ps -a --filter "label=cds.managed=true" --filter "label=cds.type=${type}" --format '{{.Names}}|{{.State}}|{{.CreatedAt}}|{{.Labels}}'`,
  );
  if (result.exitCode !== 0) return null;
  const out: DiscoveredContainer[] = [];
  for (const line of result.stdout.trim().split('\n')) {
    if (!line) continue;
    const [name, state, createdAt, labels] = line.split('|');
    if (!name) continue;
    out.push({
      name,
      running: state === 'running',
      createdAtMs: parseDockerCreatedAt(createdAt || ''),
      labels: labels || '',
    });
  }
  return out;
}

/** 宽限期判定：创建时间未知（NaN）或距今不足 MIN_AGE 都算「太新，不动」。 */
function withinGracePeriod(container: DiscoveredContainer, nowMs: number): boolean {
  if (!Number.isFinite(container.createdAtMs)) return true;
  return nowMs - container.createdAtMs < ORPHAN_CONTAINER_MIN_AGE_MS;
}

export interface TombstoneProcessResult {
  /** rm -f 成功或容器本就不存在，墓碑已消 */
  removed: string[];
  /** 同名容器比墓碑新（项目已重建），放生并消墓碑 */
  superseded: string[];
  /** docker 暂不可用等，留待下轮 */
  pending: string[];
}

/**
 * 处理项目删除留下的容器清理墓碑（Codex 两条 P2 的共同解，语义见 types.ts）。
 *
 * 每条墓碑：docker inspect 取容器 Created 时间——
 *   - 容器不存在 → 目的已达成，消墓碑；
 *   - Created 晚于墓碑 requestedAt → 同名容器属于重建的后继项目，放生并消墓碑；
 *   - 否则 rm -f，成功即消墓碑；docker 不可用/失败则留待下轮（墓碑持久化在
 *     state 里，即使删的是最后一个项目、进程中途重启也不会丢——这正是
 *     收割器空库守卫罩不住的场景）。
 */
export async function processTeardownTombstones(opts: {
  shell: IShellExecutor;
  state: TombstoneStateView;
  eventLog?: ServerEventLogSink | null;
}): Promise<TombstoneProcessResult> {
  const { shell, state, eventLog } = opts;
  const result: TombstoneProcessResult = { removed: [], superseded: [], pending: [] };
  for (const tombstone of state.getContainerTeardownTombstones()) {
    const name = tombstone.containerName;
    const inspect = await shell.exec(`docker inspect -f '{{.Created}}' ${quote(name)}`, { timeout: 15_000 });
    if (inspect.exitCode !== 0) {
      if (/no such (object|container)/i.test(inspect.stderr || '')) {
        state.removeContainerTeardownTombstone(name);
        result.removed.push(name);
        continue;
      }
      result.pending.push(name);
      continue;
    }
    const createdMs = Date.parse(inspect.stdout.trim());
    const requestedMs = Date.parse(tombstone.requestedAt);
    if (Number.isFinite(createdMs) && Number.isFinite(requestedMs) && createdMs > requestedMs) {
      state.removeContainerTeardownTombstone(name);
      result.superseded.push(name);
      eventLog?.record({
        category: 'container',
        severity: 'info',
        source: 'orphan-container-reaper',
        action: 'container.teardown.superseded',
        message: `同名容器晚于删除墓碑创建（项目已重建），放生: ${name}`,
        containerName: name,
        details: { projectId: tombstone.projectId, requestedAt: tombstone.requestedAt },
      });
      continue;
    }
    const rm = await shell.exec(`docker rm -f ${quote(name)}`, { timeout: 60_000 });
    if (rm.exitCode === 0 || /no such container/i.test(rm.stderr || '')) {
      state.removeContainerTeardownTombstone(name);
      result.removed.push(name);
      eventLog?.record({
        category: 'container',
        severity: 'warn',
        source: 'orphan-container-reaper',
        action: 'container.teardown.completed',
        message: `已按删除墓碑移除容器: ${name}`,
        containerName: name,
        details: { projectId: tombstone.projectId, requestedAt: tombstone.requestedAt },
      });
    } else {
      result.pending.push(name);
    }
  }
  return result;
}

/**
 * 单轮收割：找出孤儿 infra / app 容器并停掉（只停不删）。
 * 幂等：已停的孤儿记 already-stopped，不重复动作。
 */
export async function sweepOrphanCdsContainers(opts: {
  shell: IShellExecutor;
  state: OrphanReaperStateView;
  eventLog?: ServerEventLogSink | null;
  env?: NodeJS.ProcessEnv;
  /** 本 CDS 实例 id（computeCdsInstanceId）。传入后跳过带异实例 label 的容器。 */
  instanceId?: string;
}): Promise<OrphanSweepResult> {
  const { shell, state, eventLog } = opts;
  if (!isOrphanReaperEnabled(opts.env)) return { skippedReason: 'disabled', actions: [] };

  // 墓碑补偿先于一切守卫（Codex P2）：删除最后一个项目后 state 为空，但墓碑是
  // 持久化的显式意图，不依赖「扫描推断」，即使空库也必须重试。
  await processTeardownTombstones({ shell, state, eventLog });

  const projects = state.getProjects();
  const branches = state.getAllBranches();
  const infraServices = state.getInfraServices();
  if (projects.length === 0 && branches.length === 0 && infraServices.length === 0) {
    // 空库守卫（仅针对**扫描式**孤儿判定）：空库更可能是 state 没加载成功 /
    // 全新安装 / 同宿主第二实例，绝不能把全部容器当孤儿。墓碑路径不受此限。
    return { skippedReason: 'state-empty', actions: [] };
  }

  const [infraContainers, appContainers, proxyContainers] = await Promise.all([
    listCdsContainers(shell, 'infra'),
    listCdsContainers(shell, 'app'),
    listCdsContainers(shell, 'resource-external-access'),
  ]);
  if (infraContainers === null || appContainers === null || proxyContainers === null) {
    return { skippedReason: 'docker-query-failed', actions: [] };
  }

  const knownInfraNames = new Set(infraServices.map((s) => s.containerName).filter(Boolean));
  // app 归属精确到 branchId/profileId（Codex P2）：分支还在但某个 profile 被删/改名时，
  // 旧 profile 的容器同样是孤儿。containerName 集合作为第二道匹配（label 异常但 state
  // 仍引用该容器名时不误杀）。
  const knownAppPairs = new Set<string>();
  const knownAppContainerNames = new Set<string>();
  for (const b of branches) {
    for (const [profileId, svc] of Object.entries(b.services || {})) {
      knownAppPairs.add(`${b.id}/${profileId}`);
      if (svc?.containerName) knownAppContainerNames.add(svc.containerName);
    }
  }
  const knownBranchIds = new Set(branches.map((b) => b.id));

  const nowMs = Date.now();
  const actions: OrphanContainerAction[] = [];

  const stopOne = async (
    container: DiscoveredContainer,
    kind: 'infra' | 'app' | 'proxy',
    ownerHint: string | undefined,
  ): Promise<void> => {
    if (!container.running) {
      actions.push({ containerName: container.name, kind, ownerHint, action: 'already-stopped' });
      return;
    }
    const res = await shell.exec(`docker stop ${quote(container.name)}`, { timeout: 60_000 });
    const ok = res.exitCode === 0;
    actions.push({
      containerName: container.name,
      kind,
      ownerHint,
      action: ok ? 'stopped' : 'stop-failed',
      detail: ok ? undefined : (res.stderr || res.stdout || '').slice(0, 200),
    });
    eventLog?.record({
      category: 'container',
      severity: ok ? 'warn' : 'error',
      source: 'orphan-container-reaper',
      action: ok ? 'container.orphan.stopped' : 'container.orphan.stop-failed',
      message: ok
        ? `孤儿${kind === 'infra' ? '基础设施' : kind === 'proxy' ? '外部访问代理' : '应用'}容器已停止（state 中无 owner）: ${container.name}`
        : `孤儿容器停止失败: ${container.name}`,
      containerName: container.name,
      details: {
        kind,
        ownerHint: ownerHint || null,
        reason: 'owner-missing-in-state',
        stderr: ok ? undefined : (res.stderr || '').slice(0, 300),
      },
    });
  };

  // 异实例守卫（Codex P1）：label 带 cds.instance 且不等于本实例 → 属于同宿主
  // 另一个 CDS master，绝不触碰。无 label 的历史容器不受此限（存量孤儿要能清）。
  const belongsToOtherInstance = (c: DiscoveredContainer): boolean => {
    if (!opts.instanceId) return false;
    const label = c.labels.match(/cds\.instance=([^,]+)/)?.[1];
    return Boolean(label) && label !== opts.instanceId;
  };

  for (const c of infraContainers) {
    if (PROTECTED_CONTAINER_NAMES.has(c.name)) continue;
    if (belongsToOtherInstance(c)) continue;
    if (knownInfraNames.has(c.name)) continue;
    if (withinGracePeriod(c, nowMs)) continue;
    await stopOne(c, 'infra', undefined);
  }
  for (const c of appContainers) {
    if (belongsToOtherInstance(c)) continue;
    const branchId = c.labels.match(/cds\.branch\.id=([^,]+)/)?.[1];
    const profileId = c.labels.match(/cds\.profile\.id=([^,]+)/)?.[1];
    // 归属判定（任一命中即有主）：branchId/profileId 配对在 state、或 state 的某个
    // 分支服务仍引用该容器名。分支在但 profile 已删 → 孤儿（Codex P2）。
    if (branchId && profileId && knownAppPairs.has(`${branchId}/${profileId}`)) continue;
    if (knownAppContainerNames.has(c.name)) continue;
    // 兼容旧容器缺 profile label：分支还活着就不动（信息不全宁漏勿误）。
    if (branchId && !profileId && knownBranchIds.has(branchId)) continue;
    if (withinGracePeriod(c, nowMs)) continue;
    await stopOne(c, 'app', branchId);
  }
  // 外部访问代理容器（cds.type=resource-external-access，Codex P1）：删分支/项目
  // 会移除策略 owner 但不停代理，公网端口会一直暴露已删资源。按 branchId 判归属
  // （代理无 profileId，挂在分支上）——分支还在则保留，分支已删即孤儿，停掉即断
  // 公网暴露。收割器只停不删，与其它类型一致。
  for (const c of proxyContainers) {
    if (belongsToOtherInstance(c)) continue;
    const branchId = c.labels.match(/cds\.branch\.id=([^,]+)/)?.[1];
    if (branchId && knownBranchIds.has(branchId)) continue;
    if (withinGracePeriod(c, nowMs)) continue;
    await stopOne(c, 'proxy', branchId);
  }

  return { actions };
}
