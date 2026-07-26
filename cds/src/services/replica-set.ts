/**
 * 复制集模式（Replica Set）控制面 —— design.cds.replica-set（2026-07-23）。
 *
 * 一个分支的**单个服务**在同一入口下并排跑多个历史版本：
 *   - 主容器（branch.services[profileId]）即天然主成员，启用复制集零容器操作；
 *   - 成员只能从 reusable 的 DeploymentVersion 物化（不可变镜像，pull+run 秒起，
 *     禁止任何源码编译回退 —— 保证「快速启动」且不绕 build-gate）；
 *   - 成员运行态记在 ReplicaMember 自身，不进 branch.services（涟漪隔离）；
 *   - 解散（dissolve）= 收割全部成员容器 + 删配置，分支回到普通模式，零残留。
 *
 * 流量分配在数据面：forwarder-route-publisher 发 replicaGroup 组路由，
 * route-resolver 按权重/粘性选择。本服务只管配置与成员容器生命周期。
 */
import type {
  BranchEntry,
  BuildProfile,
  DeploymentVersion,
  IShellExecutor,
  ProfileReplicaSet,
  ReplicaDbSnapshot,
  ReplicaMember,
  ReplicaPlan,
  ReplicaPlanStep,
  ReplicaPlanStepKind,
  ServiceState,
} from '../types.js';
import type { StateService } from './state.js';
import type { ContainerService } from './container.js';
import { resolveEffectiveProfile } from './container.js';
import type { DeploymentVersionService } from './deployment-version.js';
import { cloneReplicaDb, dropReplicaDb, resolveReplicaDbTarget, envOverrideFromSnapshot } from './replica-db-clone.js';

/** 每个服务的成员上限（不含主成员）。防资源失控，超限拒绝添加。 */
export const REPLICA_MEMBER_LIMIT = 3;

/** 成员短 id：`rs` + 6 位 hex。同时用作粘性 cookie 值与直达子域后缀。 */
export function newReplicaMemberId(rand: () => number = Math.random): string {
  let suffix = '';
  for (let i = 0; i < 6; i += 1) suffix += Math.floor(rand() * 16).toString(16);
  return `rs${suffix}`;
}

export interface ReplicaSetLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface ReplicaSetServiceOptions {
  state: StateService;
  container: ContainerService;
  versions: DeploymentVersionService;
  shell: IShellExecutor;
  /** 端口分配起点（config.portStart） */
  portStart: number;
  /**
   * 远端执行器分支判定（debt #6）：executorId 指向非 embedded 执行器的分支，
   * 成员物化会错误地在 master 本机起容器，直接拒绝。由 server.ts 用 registry 注入。
   */
  isRemoteBranch?: (branch: BranchEntry) => boolean;
  logger?: ReplicaSetLogger;
  now?: () => Date;
}

/** 添加成员的入参。 */
export interface AddMemberInput {
  /**
   * 省略 = Railway 式「一个 + 号」：用分支当前版本再起一个同版本副本，
   * 权重自动取主权重（相对权重体系下即与主容器均分流量）。
   * 显式传 = 高级用法：并排某个历史版本。
   */
  versionId?: string;
  label?: string;
  /** 省略 versionId（同版本副本）时默认与主均分；显式选历史版本时默认 0（只挂直达链）。 */
  weight?: number;
  /** isolated = 一键隔离库（先整库克隆再切换）。 */
  dbMode?: 'shared' | 'isolated';
}

/** 供 UI 展示的候选版本（该 profile 可秒起的历史版本）。 */
export interface ReplicaCandidate {
  versionId: string;
  commitSha: string;
  image: string;
  createdAt: string;
  isCurrent: boolean;
}

export class ReplicaSetService {
  constructor(private readonly opts: ReplicaSetServiceOptions) {}

  /**
   * 隔离克隆在途闸（Codex P1，2026-07-26）：同源库（分支+实例+库名）同一时刻只允许
   * 一个克隆在跑。并发到达时 rs.isolated 未置位、快照未入台账，两次请求会选同一个
   * guard-N → 同名隔离库/同名 rsdb 容器 → mongo 通道的幂等 rm -f 互相摧毁对方的
   * 成功实例。在途期间重复请求直接拒绝（携带首个请求的 guardId 供提示）。
   */
  private readonly isolationInFlight = new Map<string, string>();

  private isolationKey(branchId: string, target: { infra: { containerName: string }; sourceDb: string }): string {
    return `${branchId}:${target.infra.containerName}:${target.sourceDb}`;
  }

  private now(): string {
    return (this.opts.now?.() ?? new Date()).toISOString();
  }

  /** 分支上全部复制集配置 + 每个 profile 的候选版本。 */
  list(branchId: string): {
    branch: BranchEntry;
    replicaSets: Record<string, ProfileReplicaSet>;
    candidates: Record<string, ReplicaCandidate[]>;
    snapshots: ReplicaDbSnapshot[];
  } {
    const branch = this.requireBranch(branchId);
    const candidates: Record<string, ReplicaCandidate[]> = {};
    const versions = this.opts.versions.list({ branchId });
    for (const profile of this.opts.state.getEffectiveProfilesForBranch(branch)) {
      const rows: ReplicaCandidate[] = [];
      for (const version of versions) {
        const snapshot = version.profiles.find((p) => p.profileId === profile.id);
        if (!snapshot?.reusable) continue;
        rows.push({
          versionId: version.id,
          commitSha: version.commitSha,
          image: snapshot.artifactImage,
          createdAt: version.createdAt,
          isCurrent: version.id === branch.currentVersionId,
        });
      }
      if (rows.length > 0) candidates[profile.id] = rows;
    }
    return {
      branch,
      replicaSets: branch.replicaSets ?? {},
      candidates,
      snapshots: branch.replicaDbSnapshots ?? [],
    };
  }

  /** 启用复制集：纯配置写入，不动任何容器（启用本身零秒）。幂等。 */
  enable(branchId: string, profileId: string): ProfileReplicaSet {
    const branch = this.requireBranch(branchId);
    this.requireProfile(branch, profileId);
    branch.replicaSets = branch.replicaSets ?? {};
    const existing = branch.replicaSets[profileId];
    if (existing?.enabled) return existing;
    const rs: ProfileReplicaSet = existing ?? {
      profileId,
      enabled: true,
      primaryWeight: 100,
      members: [],
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    rs.enabled = true;
    rs.updatedAt = this.now();
    branch.replicaSets[profileId] = rs;
    this.opts.state.save();
    this.opts.logger?.info?.(`[replica-set] 启用 ${branchId}/${profileId}`);
    return rs;
  }

  /**
   * 解散 = 一键退回普通模式：移除全部成员容器 + 删除配置。
   * 完成后分支与从未启用过复制集时完全一致（隔离库按保留语义不动）。
   */
  async dissolve(branchId: string, profileId: string): Promise<void> {
    const branch = this.requireBranch(branchId);
    const rs = branch.replicaSets?.[profileId];
    if (!rs) return;
    for (const member of rs.members) {
      await this.removeMemberContainer(member);
    }
    delete branch.replicaSets![profileId];
    if (Object.keys(branch.replicaSets!).length === 0) delete branch.replicaSets;
    this.clearModeIfEmpty(branch);
    this.opts.state.save();
    this.opts.logger?.info?.(`[replica-set] 解散 ${branchId}/${profileId}（退回普通模式）`);
  }

  /** 全分支成员总数（模式二选一的判据） */
  private totalMemberCount(branch: BranchEntry): number {
    return Object.values(branch.replicaSets ?? {}).reduce((s, rs) => s + rs.members.length, 0);
  }

  /** 副本清零 → 自动解除模式钉住，允许下次换另一种管理模式 */
  private clearModeIfEmpty(branch: BranchEntry): void {
    if (branch.replicaMode && this.totalMemberCount(branch) === 0) delete branch.replicaMode;
  }

  /**
   * 添加成员并异步物化容器。同步返回 provisioning 态成员；
   * 启动进展通过 member.status 轮询可见（禁止空白等待由 UI 轮询承担）。
   */
  addMember(branchId: string, profileId: string, input: AddMemberInput): ReplicaMember {
    const branch = this.requireBranch(branchId);
    const profile = this.requireProfile(branch, profileId);
    if (this.opts.isRemoteBranch?.(branch)) {
      throw new ReplicaSetError(409, '该分支部署在远端执行器上，复制集暂只支持本机（embedded）分支');
    }
    // 隔离克隆期间禁加成员（Codex P1）：克隆开始时快照的成员数组决定「第2步
    // 切换」覆盖谁——克隆中途加入的成员会以共享库身份启动、切换循环碰不到它，
    // 而隔离标记照常生效：UI 与审计声称隔离，新成员却仍在写主库。克隆是分钟级
    // 短窗口，拒绝并提示等待是最可预期的行为。
    {
      const { target: gateTarget } = resolveReplicaDbTarget(this.opts.state, branch, profile);
      if (gateTarget && this.isolationInFlight.has(this.isolationKey(branchId, gateTarget))) {
        throw new ReplicaSetError(409, '该服务的数据库正在隔离克隆中，请等隔离完成后再添加副本');
      }
    }
    const rs = this.enable(branchId, profileId);
    if (rs.members.length >= REPLICA_MEMBER_LIMIT) {
      throw new ReplicaSetError(409, `成员数已达上限 ${REPLICA_MEMBER_LIMIT}，请先下线一个成员`);
    }
    if (input.dbMode === 'isolated') {
      // 先做可行性预检，把「没有库可隔离 / infra 没在跑」这类失败在同步阶段就讲清楚
      const { target, reason } = resolveReplicaDbTarget(this.opts.state, branch, profile);
      if (!target) throw new ReplicaSetError(409, `无法隔离数据库：${reason}`);
    }
    // 「一个 + 号」路径：不传 versionId 就复制当前版本（同版本水平副本）
    const isQuickReplica = !input.versionId;
    const targetVersionId = input.versionId || branch.currentVersionId;
    if (!targetVersionId) {
      throw new ReplicaSetError(409, '该分支还没有可复用的部署版本（先完成一次极速版/托管构建部署）');
    }
    const version = this.opts.versions.get(targetVersionId);
    if (!version || version.branchId !== branchId) {
      throw new ReplicaSetError(404, `部署版本不存在或不属于该分支: ${targetVersionId}`);
    }
    const snapshot = version.profiles.find((p) => p.profileId === profileId);
    if (!snapshot) {
      throw new ReplicaSetError(409, `该版本没有服务 ${profileId} 的快照`);
    }
    if (!snapshot.reusable) {
      throw new ReplicaSetError(409, `该版本的 ${profileId} 产物不可复用（${snapshot.reuseBlockedReason || '非不可变镜像'}），无法秒起为成员`);
    }
    // 同版本查重只拦「显式选历史版本」的误点；快速副本（+ 号）天然就是同版本多实例
    if (!isQuickReplica && rs.members.some((m) => m.versionId === version.id && m.status !== 'error')) {
      throw new ReplicaSetError(409, '该版本已是复制集成员');
    }

    // 成员命名规范（用户拍板）：res-1 / res-2 … 顺位递增，不用随机串。
    // 序号取「现役成员 + 隔离库快照」已用序号的 max+1，防止下线重加后与
    // 快照 id（rsdb_<memberId>）撞车。
    const usedOrdinals = [
      ...rs.members.map((m) => m.id),
      ...((branch.replicaDbSnapshots ?? []).map((s) => s.memberId)),
    ]
      .map((mid) => /^res-(\d+)$/.exec(mid)?.[1])
      .filter(Boolean)
      .map(Number);
    const nextOrdinal = usedOrdinals.length ? Math.max(...usedOrdinals) + 1 : 1;
    const member: ReplicaMember = {
      id: `res-${nextOrdinal}`,
      versionId: version.id,
      label: input.label?.trim() || (isQuickReplica ? `副本 ${rs.members.length + 1}` : version.commitSha.slice(0, 7)),
      // 快速副本默认与主同权重（相对权重体系 = 均分流量，Railway 语义）；历史版本默认 0 只挂直达
      weight: clampWeight(input.weight ?? (isQuickReplica ? rs.primaryWeight : 0)),
      image: snapshot.artifactImage,
      commitSha: version.commitSha,
      status: 'provisioning',
      statusMessage: input.dbMode === 'isolated' ? '正在克隆数据库到隔离库…' : undefined,
      dbMode: input.dbMode === 'isolated' ? 'isolated' : 'shared',
      createdAt: this.now(),
    };
    rs.members.push(member);
    rs.updatedAt = this.now();
    this.opts.state.save();

    void this.materializeMember(branch.id, profileId, member.id, version, profile)
      .catch((err) => {
        this.opts.logger?.error?.(
          `[replica-set] 成员物化失败 ${branchId}/${profileId}/${member.id}: ${(err as Error).message}`,
        );
      });
    return member;
  }

  /** 改权重 / 标签。改权重 = 纯配置写入，2s 内路由表重发生效，无容器操作。 */
  updateMember(
    branchId: string,
    profileId: string,
    memberId: string,
    patch: { weight?: number; label?: string; primaryWeight?: number },
  ): ProfileReplicaSet {
    const branch = this.requireBranch(branchId);
    const rs = branch.replicaSets?.[profileId];
    if (!rs) throw new ReplicaSetError(404, '该服务未启用复制集');
    if (memberId === 'primary') {
      if (typeof patch.weight === 'number') rs.primaryWeight = clampWeight(patch.weight);
    } else {
      const member = rs.members.find((m) => m.id === memberId);
      if (!member) throw new ReplicaSetError(404, `成员不存在: ${memberId}`);
      if (typeof patch.weight === 'number') member.weight = clampWeight(patch.weight);
      if (typeof patch.label === 'string' && patch.label.trim()) member.label = patch.label.trim();
    }
    if (typeof patch.primaryWeight === 'number') rs.primaryWeight = clampWeight(patch.primaryWeight);
    rs.updatedAt = this.now();
    this.opts.state.save();
    return rs;
  }

  /** 下线成员：移除容器 + 删记录（隔离库按保留语义不动）。 */
  async removeMember(branchId: string, profileId: string, memberId: string): Promise<void> {
    const branch = this.requireBranch(branchId);
    const rs = branch.replicaSets?.[profileId];
    if (!rs) throw new ReplicaSetError(404, '该服务未启用复制集');
    const member = rs.members.find((m) => m.id === memberId);
    if (!member) throw new ReplicaSetError(404, `成员不存在: ${memberId}`);
    await this.removeMemberContainer(member);
    rs.members = rs.members.filter((m) => m.id !== memberId);
    // 2026-07-25 语义更新（替代 R9-P3 的自动清挂）：零副本隔离已是合法状态
    //（隔离先行、副本后加会自动连隔离库），末位成员下线**保留**隔离标志——
    // 解除隔离走显式回切（revert-db）或解散（dissolve）。
    rs.updatedAt = this.now();
    this.clearModeIfEmpty(branch);
    this.opts.state.save();
  }

  /**
   * 删除隔离库快照：drop 数据库 + 移除台账记录。
   * 这是「保留语义」的唯一出口——只有用户显式删除才会 drop。
   */
  async deleteDbSnapshot(branchId: string, snapshotId: string): Promise<ReplicaDbSnapshot> {
    const branch = this.requireBranch(branchId);
    const snapshot = (branch.replicaDbSnapshots || []).find((s) => s.id === snapshotId);
    if (!snapshot) throw new ReplicaSetError(404, `隔离库快照不存在: ${snapshotId}`);
    // 终验 R9-P3：正被活跃隔离引用的快照不许删（删了副本会连着已 drop 的库跑）
    for (const rs of Object.values(branch.replicaSets || {})) {
      const activelyUsed = rs.isolated?.snapshotId === snapshotId
        || rs.members.some((m) => m.isolatedDbName === snapshot.dbName && (m.status === 'running' || m.status === 'provisioning'));
      if (activelyUsed) {
        throw new ReplicaSetError(409, `隔离库 ${snapshot.dbName} 正被 ${rs.profileId} 的副本使用中，请先「回切主库」再删除快照`);
      }
    }
    const infra = this.opts.state.getInfraServicesForProject(branch.projectId)
      .find((svc) => svc.containerName === snapshot.infraContainer);
    await dropReplicaDb(snapshot, infra?.env || {});
    branch.replicaDbSnapshots = (branch.replicaDbSnapshots || []).filter((s) => s.id !== snapshotId);
    if (branch.replicaDbSnapshots.length === 0) delete branch.replicaDbSnapshots;
    this.opts.state.save();
    this.opts.logger?.info?.(`[replica-set] 隔离库已删除 ${branchId}/${snapshot.dbName}`);
    return snapshot;
  }

  /**
   * 数据库保护罩（用户拍板）：数据库芯片锁按钮的一键克隆——不绑成员，
   * 把该 infra 承载的当前库整库克隆成隔离副本，进快照台账（保留语义）。
   * 进度经 onStage 回调（cloning/done/error），路由层暴露轮询端点。
   */
  startDbGuard(
    branchId: string,
    infraId: string,
    onStage: (stage: 'cloning' | 'done' | 'error', detail: string, dbName?: string) => void,
  ): { accepted: boolean; reason?: string } {
    const branch = this.opts.state.getBranch(branchId);
    if (!branch) return { accepted: false, reason: `分支不存在: ${branchId}` };
    // 找到「用这个 infra 当数据库」的服务：逐 profile 解析目标，命中 infraId 即用
    let target: ReturnType<typeof resolveReplicaDbTarget>['target'] = null;
    let profileId = '';
    for (const profile of this.opts.state.getEffectiveProfilesForBranch(branch)) {
      const resolved = resolveReplicaDbTarget(this.opts.state, branch, resolveEffectiveProfile(profile, branch));
      if (resolved.target && resolved.target.infra.id === infraId) {
        target = resolved.target;
        profileId = profile.id;
        break;
      }
    }
    if (!target) return { accepted: false, reason: '没有服务把该基础设施用作数据库（或库名 env 缺失），无法定位要保护的库' };
    const inflightKey = this.isolationKey(branchId, target);
    if (this.isolationInFlight.has(inflightKey)) {
      return { accepted: false, reason: `该源库已有一个隔离克隆在进行中（${this.isolationInFlight.get(inflightKey)}），请等它完成后再操作` };
    }
    const used = (branch.replicaDbSnapshots ?? [])
      .map((s) => /^guard-(\d+)$/.exec(s.memberId)?.[1]).filter(Boolean).map(Number);
    const guardId = `guard-${used.length ? Math.max(...used) + 1 : 1}`;
    this.isolationInFlight.set(inflightKey, guardId);
    void cloneReplicaDb({
      target,
      memberId: guardId,
      profileId,
      branchId: branch.id,
      now: this.opts.now,
      onOutput: (line) => onStage('cloning', line),
    }).then(async (cloned) => {
      // 归属复查（Codex P1）：克隆是长任务，期间分支/项目可能已被删除——快照
      // 还没入台账，删除路径清不到它。此时必须就地 drop 刚克隆的产物（专用
      // 实例整容器 / 共享库里的隔离库），否则永久无主。
      const liveBranch = this.opts.state.getBranch(branchId);
      if (!liveBranch) {
        try {
          await dropReplicaDb(cloned.snapshot, target!.infra.env || {});
          onStage('error', `分支在克隆期间被删除，已清理刚克隆的隔离库 ${cloned.snapshot.dbName}`);
        } catch {
          onStage('error', `分支在克隆期间被删除，且隔离库 ${cloned.snapshot.dbName} 清理失败——请到数据库工作台手动 DROP${cloned.snapshot.dedicatedContainer ? `（专用实例 ${cloned.snapshot.dedicatedContainer}）` : ''}`);
        }
        return;
      }
      liveBranch.replicaDbSnapshots = [...(liveBranch.replicaDbSnapshots || []), cloned.snapshot];
      this.opts.state.save();
      onStage('done', `隔离副本 ${cloned.snapshot.dbName} 已就绪（来源 ${cloned.snapshot.sourceDb}）`, cloned.snapshot.dbName);
    }).catch((err) => {
      onStage('error', (err as Error).message);
    }).finally(() => {
      this.isolationInFlight.delete(inflightKey);
    });
    return { accepted: true };
  }

  /**
   * profile 级「复制隔离」（用户拍板的三步心智）：
   *   第1步 复制：整库克隆一次成隔离库（主库不动）；
   *   第2步 切换：全体副本重新物化，env 改指隔离库（主实例保持连主库）；
   *   可回切：revertProfile 把副本切回主库，隔离库转为快照保留。
   * 异步执行，进度经 rs.isolated 与成员 status 轮询可见。
   */
  isolateProfile(branchId: string, profileId: string): { accepted: boolean; reason?: string } {
    const branch = this.requireBranch(branchId);
    // 2026-07-25 用户拍板：隔离不再强制「先有副本」——零副本也可隔离（先建好隔离库并
    // 钉住隔离态，之后加的副本自动连隔离库）。enable 幂等，无 rs 条目时就地建。
    const rs = this.enable(branchId, profileId);
    if (rs.isolated) return { accepted: false, reason: '已处于隔离状态' };
    const members = rs.members.filter((m) => m.status === 'running');
    const baseProfile = this.requireProfile(branch, profileId);
    const { target, reason } = resolveReplicaDbTarget(this.opts.state, branch, baseProfile);
    if (!target) return { accepted: false, reason: `无法定位数据库：${reason}` };
    // 统一战线同库复用：同一分支里已有别的服务把**同一个源库**隔离过（活跃隔离引用的
    // 快照），直接复用那份隔离库/专用实例——多服务隔离禁止各克隆一份导致数据分叉。
    // 同库判定必须含来源实例（Codex P1）：同引擎两个 infra 实例里可以各有一个
    // 同名库——只比库名会把 A 实例的克隆错发给连 B 实例的服务（mongo 专用实例
    // 快照直接把服务重定向到 A 的数据；mysql/pg 则指向 B 上从未克隆过的库名）。
    const reusable = (branch.replicaDbSnapshots ?? []).find((snap) =>
      snap.sourceDb === target.sourceDb && snap.engine === target.engine
      && snap.infraContainer === target.infra.containerName
      && Object.values(branch.replicaSets ?? {}).some((x) => x.isolated?.snapshotId === snap.id));
    if (reusable) {
      rs.isolated = { dbName: reusable.dbName, snapshotId: reusable.id, isolatedAt: this.now() };
      rs.updatedAt = this.now();
      this.opts.state.save();
      const envOverride = envOverrideFromSnapshot(target, reusable);
      void (async () => {
        for (const m of members) {
          this.patchMember(branchId, profileId, m.id, { status: 'provisioning', statusMessage: '第2步 切换：复用统一隔离库，重启副本改连…' });
          if (m.containerName) {
            await this.opts.container.remove(m.containerName, { actor: 'replica-set', trigger: 'replica-isolate' }).catch(() => undefined);
          }
          const version = this.opts.versions.get(m.versionId);
          if (!version) {
            this.patchMember(branchId, profileId, m.id, { status: 'error', statusMessage: `部署版本已不存在: ${m.versionId}` });
            continue;
          }
          await this.materializeMember(branchId, profileId, m.id, version, baseProfile, {
            envOverride, dbName: reusable.dbName,
          });
        }
        this.opts.logger?.info?.(`[replica-set] 复制隔离（同库复用）${branchId}/${profileId} → ${reusable.dbName}`);
      })();
      return { accepted: true };
    }
    const inflightKey = this.isolationKey(branchId, target);
    if (this.isolationInFlight.has(inflightKey)) {
      return { accepted: false, reason: `该源库已有一个隔离克隆在进行中（${this.isolationInFlight.get(inflightKey)}），请等它完成后再操作` };
    }
    const used = [
      ...(branch.replicaDbSnapshots ?? []).map((s) => s.memberId),
    ].map((mid) => /^guard-(\d+)$/.exec(mid)?.[1]).filter(Boolean).map(Number);
    const guardId = `guard-${used.length ? Math.max(...used) + 1 : 1}`;
    this.isolationInFlight.set(inflightKey, guardId);
    for (const m of members) {
      this.patchMember(branchId, profileId, m.id, { status: 'provisioning', statusMessage: '第1步 复制：正在克隆隔离库…' });
    }
    void (async () => {
      try {
        const cloned = await cloneReplicaDb({
          target, memberId: guardId, profileId, branchId, now: this.opts.now,
          // 复验 R5-P1：克隆保护/进度必须有用户可见 sink——透传到成员 statusMessage
          //（保持「第1步」前缀，UI 的隔离阶段判定依赖它）+ 服务端日志
          onOutput: (line) => {
            this.opts.logger?.info?.(`[replica-set] ${branchId}/${profileId} ${line}`);
            for (const m of members) {
              this.patchMember(branchId, profileId, m.id, { statusMessage: `第1步 复制：${line.slice(0, 200)}` });
            }
          },
        });
        // 归属复查（Codex P1）：克隆期间分支被删 → 快照未入台账、删除路径清不到，
        // 就地 drop 刚克隆的产物后放弃
        const live = this.opts.state.getBranch(branchId);
        if (!live || !live.replicaSets?.[profileId]) {
          await dropReplicaDb(cloned.snapshot, target.infra.env || {}).catch(() => undefined);
          this.opts.logger?.warn?.(
            `[replica-set] 分支/复制集在隔离克隆期间被删除，已清理刚克隆的隔离库 ${cloned.snapshot.dbName}`,
          );
          return;
        }
        live.replicaDbSnapshots = [...(live.replicaDbSnapshots || []), cloned.snapshot];
        const liveRs = live.replicaSets[profileId];
        liveRs.isolated = { dbName: cloned.snapshot.dbName, snapshotId: cloned.snapshot.id, isolatedAt: this.now() };
        this.opts.state.save();
        for (const m of members) {
          this.patchMember(branchId, profileId, m.id, { statusMessage: '第2步 切换：重启副本改连隔离库…' });
          if (m.containerName) {
            await this.opts.container.remove(m.containerName, { actor: 'replica-set', trigger: 'replica-isolate' }).catch(() => undefined);
          }
          const version = this.opts.versions.get(m.versionId);
          if (!version) {
            this.patchMember(branchId, profileId, m.id, { status: 'error', statusMessage: `部署版本已不存在: ${m.versionId}` });
            continue;
          }
          await this.materializeMember(branchId, profileId, m.id, version, baseProfile, {
            envOverride: cloned.envOverride,
            dbName: cloned.snapshot.dbName,
          });
        }
        this.opts.logger?.info?.(`[replica-set] 复制隔离完成 ${branchId}/${profileId} → ${cloned.snapshot.dbName}`);
      } catch (err) {
        for (const m of members) {
          this.patchMember(branchId, profileId, m.id, { status: 'error', statusMessage: `复制隔离失败：${(err as Error).message}` });
        }
      } finally {
        this.isolationInFlight.delete(inflightKey);
      }
    })();
    return { accepted: true };
  }

  /** 回切主库：副本重物化回共享库；隔离库不删，作为快照留在台账。 */
  revertProfile(branchId: string, profileId: string): { accepted: boolean; reason?: string } {
    const branch = this.requireBranch(branchId);
    const rs = branch.replicaSets?.[profileId];
    if (!rs?.isolated) return { accepted: false, reason: '当前不在隔离状态' };
    const baseProfile = this.requireProfile(branch, profileId);
    const members = rs.members.filter((m) => m.status === 'running' || m.status === 'error');
    delete rs.isolated;
    rs.updatedAt = this.now();
    this.opts.state.save();
    void (async () => {
      for (const m of members) {
        this.patchMember(branchId, profileId, m.id, {
          status: 'provisioning', statusMessage: '回切主库：重启副本恢复原连接…', dbMode: 'shared', isolatedDbName: undefined,
        });
        if (m.containerName) {
          await this.opts.container.remove(m.containerName, { actor: 'replica-set', trigger: 'replica-revert' }).catch(() => undefined);
        }
        const version = this.opts.versions.get(m.versionId);
        if (!version) {
          this.patchMember(branchId, profileId, m.id, { status: 'error', statusMessage: `部署版本已不存在: ${m.versionId}` });
          continue;
        }
        await this.materializeMember(branchId, profileId, m.id, version, baseProfile);
      }
      this.opts.logger?.info?.(`[replica-set] 已回切主库 ${branchId}/${profileId}（隔离库保留为快照）`);
    })();
    return { accepted: true };
  }

  /** 分支删除/停止路径的级联收割：清掉该分支全部成员容器。 */
  async teardownForBranch(branchId: string): Promise<void> {
    const branch = this.opts.state.getBranch(branchId);
    if (!branch?.replicaSets) return;
    for (const rs of Object.values(branch.replicaSets)) {
      for (const member of rs.members) {
        await this.removeMemberContainer(member).catch((err) => {
          this.opts.logger?.warn?.(
            `[replica-set] 分支收割成员容器失败 ${branchId}/${rs.profileId}/${member.id}: ${(err as Error).message}`,
          );
        });
      }
    }
    delete branch.replicaSets;
    this.opts.state.save();
  }

  /**
   * 物化成员容器：从版本快照构造独立 profile（id 加 --<memberId> 后缀，
   * DNS 别名/容器名随之隔离，不与主容器撞车），走 ContainerService.runService
   * 既有链路（pull、分支网、清理）。全程零编译：
   *   - prebuiltImage=true 且 fallbackImage/sourceFallbackProfile 置空
   *     → 镜像拉不到直接失败进 error 态，绝不回退源码编译（不绕 build-gate）。
   */
  private async materializeMember(
    branchId: string,
    profileId: string,
    memberId: string,
    version: DeploymentVersion,
    baseProfile: BuildProfile,
    dbOverride?: { envOverride: Record<string, string>; dbName: string },
  ): Promise<void> {
    const branch = this.requireBranch(branchId);
    const snapshot = version.profiles.find((p) => p.profileId === profileId)!;
    const memberProfileId = `${profileId}--${memberId}`;
    const memberProfile: BuildProfile = {
      ...baseProfile,
      id: memberProfileId,
      name: `${baseProfile.name} · ${memberId}`,
      dockerImage: snapshot.artifactImage,
      command: snapshot.runtimeCommand,
      containerPort: snapshot.containerPort,
      containerWorkDir: snapshot.containerWorkDir,
      pathPrefixes: snapshot.pathPrefixes,
      // 成员不发命名子域（直达入口由发布器按 memberId 生成），避免与主容器同名子域撞车
      subdomain: undefined,
      dependsOn: [],
      readinessProbe: snapshot.readinessProbe,
      startupSignal: snapshot.startupSignal,
      activeDeployMode: snapshot.deployedMode,
      prebuiltImage: true,
      localArtifact: snapshot.artifactKind === 'managed-image',
      managedBuild: undefined,
      fallbackImage: undefined,
      sourceFallbackProfile: undefined,
      hotReload: undefined,
      // 实例指纹（硬实力取证）：每个副本容器注入自己的身份 env。
      // 应用可读可回显；即使应用不理会，docker inspect / 容器 env 也能对账，
      // 配合 forwarder 的 X-CDS-Replica 响应头形成完整追踪链。
      env: {
        ...(baseProfile.env || {}),
        CDS_REPLICA_ID: memberId,
        CDS_REPLICA_INSTANCE: `${memberId}-${Math.random().toString(16).slice(2, 10)}`,
      },
    };

    const usedPorts = await this.collectListeningPorts();
    const hostPort = this.opts.state.allocatePort(this.opts.portStart, usedPorts);
    const containerName = `cds-${branch.id}-${profileId}-${memberId}`;
    const serviceState: ServiceState = {
      profileId: memberProfileId,
      containerName,
      hostPort,
      status: 'starting',
    };
    this.patchMember(branchId, profileId, memberId, { containerName, hostPort });

    const logs: string[] = [];
    const onOutput = (chunk: string) => {
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) logs.push(trimmed);
      }
      if (logs.length > 40) logs.splice(0, logs.length - 40);
    };

    // 一键隔离数据库（MVP-2）：先克隆当前库 → 成员 env 指向隔离库 → 才启动容器。
    // memberProfile.dbScope 钉成 shared：库名已是折算后的运行时全名（含 per-branch
    // 后缀），不能让 runService 内部再叠一次分支后缀。
    // profile 级复制隔离（isolateProfile）：库已克隆好，直接套用 env 覆写
    if (dbOverride) {
      memberProfile.env = { ...(memberProfile.env || {}), ...dbOverride.envOverride };
      memberProfile.dbScope = 'shared';
      this.patchMember(branchId, profileId, memberId, { dbMode: 'isolated', isolatedDbName: dbOverride.dbName });
    }
    // 统一战线（2026-07-25）：该服务已处于隔离态时，新加的副本自动连**既有**隔离库，
    // 不再各克隆一份——先隔离后加副本 与 先加副本后隔离 殊途同归。
    let joinedIsolated = false;
    if (!dbOverride) {
      const liveRs = this.opts.state.getBranch(branchId)?.replicaSets?.[profileId];
      const snap = liveRs?.isolated
        ? (this.opts.state.getBranch(branchId)?.replicaDbSnapshots ?? []).find((x) => x.id === liveRs.isolated!.snapshotId)
        : undefined;
      if (liveRs?.isolated && snap) {
        const { target } = resolveReplicaDbTarget(this.opts.state, branch, baseProfile);
        if (target) {
          memberProfile.env = { ...(memberProfile.env || {}), ...envOverrideFromSnapshot(target, snap) };
          memberProfile.dbScope = 'shared';
          this.patchMember(branchId, profileId, memberId, { dbMode: 'isolated', isolatedDbName: snap.dbName });
          joinedIsolated = true;
        }
      }
    }
    const currentMember = this.opts.state.getBranch(branchId)?.replicaSets?.[profileId]?.members
      .find((m) => m.id === memberId);
    if (!dbOverride && !joinedIsolated && currentMember?.dbMode === 'isolated') {
      const { target, reason } = resolveReplicaDbTarget(this.opts.state, branch, baseProfile);
      if (!target) {
        this.patchMember(branchId, profileId, memberId, { status: 'error', statusMessage: `无法隔离数据库：${reason}` });
        return;
      }
      try {
        const cloned = await cloneReplicaDb({
          target,
          memberId,
          profileId,
          branchId,
          now: this.opts.now,
          onOutput,
        });
        // 物化栅栏（Codex P2，2026-07-26）：克隆是长 await，期间用户可能已把成员
        // 移除/复制集解散——记录没了还往台账追加快照会留下无主隔离库。确认成员
        // 仍在册才入账；不在就顺手把刚克隆出来的库清掉（best-effort）。
        if (!this.memberStillTracked(branchId, profileId, memberId)) {
          try {
            const infraEnv = this.opts.state.getInfraServicesForProject(branch.projectId)
              .find((s) => s.containerName === cloned.snapshot.infraContainer)?.env || {};
            await dropReplicaDb(cloned.snapshot, infraEnv);
          } catch { /* best-effort：清不掉留给快照台账人工删 */ }
          this.opts.logger?.warn?.(
            `[replica-set] 成员在隔离克隆期间被移除，放弃物化并清理克隆库 ${branchId}/${profileId}/${memberId}`,
          );
          return;
        }
        memberProfile.env = { ...(memberProfile.env || {}), ...cloned.envOverride };
        memberProfile.dbScope = 'shared';
        const liveBranch = this.requireBranch(branchId);
        liveBranch.replicaDbSnapshots = [...(liveBranch.replicaDbSnapshots || []), cloned.snapshot];
        this.patchMember(branchId, profileId, memberId, {
          isolatedDbName: cloned.snapshot.dbName,
          statusMessage: '隔离库克隆完成，正在启动容器…',
        });
      } catch (err) {
        this.patchMember(branchId, profileId, memberId, {
          status: 'error',
          statusMessage: (err as Error).message,
        });
        return;
      }
    }

    // 物化栅栏（Codex P2，2026-07-26）：端口分配/克隆等 await 期间成员可能已被
    // 移除或复制集已解散——removeMember 只能移除**当时存在**的容器，本任务继续
    // 跑会再起一个台账外的幽灵容器（谁都停不掉，只能等孤儿收割器）。启动前
    // 最后确认成员仍在册，不在就地放弃。
    if (!this.memberStillTracked(branchId, profileId, memberId)) {
      this.opts.logger?.warn?.(
        `[replica-set] 成员在物化期间被移除，放弃启动容器 ${branchId}/${profileId}/${memberId}`,
      );
      return;
    }
    try {
      await this.opts.container.runService(
        branch,
        memberProfile,
        serviceState,
        onOutput,
        this.buildMemberEnv(branch),
        { actor: 'replica-set', trigger: 'replica-set-member' },
      );
      let ready = true;
      if (memberProfile.startupSignal) {
        ready = await this.opts.container.waitForStartupSignal(
          containerName,
          memberProfile.startupSignal,
          onOutput,
          120,
        );
      } else {
        ready = await this.opts.container.waitForReadiness(
          hostPort,
          memberProfile.readinessProbe,
          undefined,
          onOutput,
          containerName,
        );
      }
      if (!ready) {
        this.patchMember(branchId, profileId, memberId, {
          status: 'error',
          statusMessage: `容器已启动但未就绪: ${logs.slice(-5).join(' | ') || '无输出'}`,
        });
        return;
      }
      // 收尾栅栏（Codex P2）：容器启动/就绪等待期间成员被移除 → 刚起的容器已经
      // 没有台账记录（patchMember 会静默 no-op），必须就地拆掉，不留幽灵。
      if (!this.memberStillTracked(branchId, profileId, memberId)) {
        try {
          await this.opts.container.remove(containerName, {
            actor: 'replica-set',
            trigger: 'replica-set-remove',
          });
        } catch { /* best-effort：拆不掉交给孤儿收割器（无主容器过 grace 即收） */ }
        this.opts.logger?.warn?.(
          `[replica-set] 成员在容器启动期间被移除，已拆除刚启动的容器 ${containerName}`,
        );
        return;
      }
      this.patchMember(branchId, profileId, memberId, { status: 'running', statusMessage: undefined });
      this.opts.logger?.info?.(
        `[replica-set] 成员就绪 ${branchId}/${profileId}/${memberId} :${hostPort} (${snapshot.artifactImage})`,
      );
    } catch (err) {
      this.patchMember(branchId, profileId, memberId, {
        status: 'error',
        statusMessage: (err as Error).message,
      });
    }
  }

  /**
   * 成员运行 env：与部署循环 getMergedEnv 同口径（2026-07-23 真实验收修复）——
   * 首版只传 getCustomEnv，缺 CDS 派生变量（CDS_HOST / CDS_<infra>_PORT），
   * env 模板解析直接失败「环境变量模板缺少值」。合并顺序与 branches.ts 一致：
   * cds 派生 → 镜像加速 → 项目/全局自定义 → 分支 scope → 项目身份保留键。
   */
  private buildMemberEnv(branch: BranchEntry): Record<string, string> {
    const projectId = branch.projectId || 'default';
    const project = this.opts.state.getProject(projectId);
    return {
      ...this.opts.state.getCdsEnvVars(projectId),
      ...this.opts.state.getMirrorEnvVars(),
      ...this.opts.state.getCustomEnv(projectId),
      ...this.opts.state.getCustomEnvScope(branch.id),
      ...(project ? { CDS_PROJECT_ID: project.id, CDS_PROJECT_SLUG: project.slug } : {}),
    };
  }

  /**
   * 物化栅栏判据（Codex P2 + P1 补强）：成员记录仍在册**且未被停止**。
   * 移除/解散会删记录；分支停止/调度器降温会把 provisioning 成员标 stopped
   *（记录保留）——两种情况后台物化任务都必须就地放弃，否则会在分支已 idle
   * 后把副本容器起出来。
   */
  private memberStillTracked(branchId: string, profileId: string, memberId: string): boolean {
    const member = this.opts.state.getBranch(branchId)?.replicaSets?.[profileId]?.members
      .find((m) => m.id === memberId);
    return !!member && member.status !== 'stopped';
  }

  private patchMember(
    branchId: string,
    profileId: string,
    memberId: string,
    patch: Partial<ReplicaMember>,
  ): void {
    const branch = this.opts.state.getBranch(branchId);
    const member = branch?.replicaSets?.[profileId]?.members.find((m) => m.id === memberId);
    if (!member) return;
    Object.assign(member, patch);
    if (branch?.replicaSets?.[profileId]) branch.replicaSets[profileId].updatedAt = this.now();
    this.opts.state.save();
  }

  /* ── 执行计划引擎（草稿-保存模型，2026-07-24 用户拍板）──
   * 用户在舞台上把操作排成有序步骤，「保存」后本引擎串行执行：
   * 每步等到真实终态才走下一步；执行中允许重排/跳过 pending 步骤、取消剩余；
   * 失败按策略 stop（停止剩余）或 rollback（逆序回滚已完成步骤）；
   * 全程落 branch.replicaPlans 记录（含错误与回滚日志），保留最近 20 条。 */

  /**
   * 启动收敛（用户点名的「更新 CDS 导致不一致」防线）：CDS 自更新/崩溃重启会
   * 打断执行中的计划——runner 是进程内异步循环，重启后不会复活。开机扫描所有
   * 分支的 running 计划：running 步骤标 error（明示被重启打断）、pending 标
   * cancelled、计划标 error——绝不留「看起来在执行、实际没人跑」的僵尸态；
   * 用户在执行记录里能看到确切原因并自行重试（幂等：步骤都可重新入队）。
   */
  reconcileInterruptedPlans(): number {
    let fixed = 0;
    for (const branch of this.opts.state.getAllBranches()) {
      for (const plan of branch.replicaPlans || []) {
        if (plan.status !== 'running') continue;
        for (const s of plan.steps) {
          if (s.status === 'running') { s.status = 'error'; s.error = 'CDS 服务重启，步骤被打断——请核对现场后重新保存计划'; s.endedAt = this.now(); }
          else if (s.status === 'pending') { s.status = 'cancelled'; s.endedAt = this.now(); }
        }
        plan.status = 'error';
        plan.endedAt = this.now();
        fixed += 1;
        this.opts.logger?.warn?.(`[replica-plan] 启动收敛：${branch.id}/${plan.id} 因 CDS 重启标记为中断`);
      }
    }
    if (fixed > 0) this.opts.state.save();
    return fixed;
  }

  /* ── 副本容器真身对账（2026-07-26 孤儿收割器误杀事故的第二道防线）──
   * 事故：收割器不认识成员容器（认领已修），5 个 running 副本被优雅停掉后
   * state 仍标 running → forwarder 按权重把入口真实流量打到死端口（50% 503）。
   * 对账原则：status 是控制面意图，容器真身以 docker 为准——任何原因死掉的
   * 副本（误杀/OOM/crash/人为 stop）都要在一个对账周期内标 error 摘流。
   * 路由发布器只发 running 成员且每 2s 重建路由，标记后自动收敛。 */

  /**
   * 全量对账：docker ps 存活容器名集合 vs state 里 running 成员的容器名。
   * 不在集合里 → 标 error（带原因，UI 红显 + 摘流）。docker 查询失败本轮放弃
   * （宁漏勿误，与孤儿收割器同一纪律）。返回本轮标记数。
   */
  async reconcileMembersAgainstDocker(): Promise<number> {
    const tracked: Array<{ branchId: string; profileId: string; memberId: string; containerName: string }> = [];
    for (const branch of this.opts.state.getAllBranches()) {
      for (const rs of Object.values(branch.replicaSets ?? {})) {
        for (const m of rs.members) {
          if (m.status === 'running' && m.containerName) {
            tracked.push({ branchId: branch.id, profileId: rs.profileId, memberId: m.id, containerName: m.containerName });
          }
        }
      }
    }
    if (tracked.length === 0) return 0;
    const res = await this.opts.shell.exec(
      `docker ps --filter "label=cds.managed=true" --format '{{.Names}}'`,
      { timeout: 30_000 },
    );
    if (res.exitCode !== 0) return 0;
    const alive = new Set(res.stdout.trim().split('\n').map((s) => s.trim()).filter(Boolean));
    let marked = 0;
    for (const t of tracked) {
      if (alive.has(t.containerName)) continue;
      this.patchMember(t.branchId, t.profileId, t.memberId, {
        status: 'error',
        statusMessage: '副本容器已不在运行（对账发现）——已从入口分流摘除；可在画布删除后重建副本',
      });
      marked += 1;
      this.opts.logger?.warn?.(
        `[replica-set] 对账：${t.branchId}/${t.profileId}/${t.memberId} 容器 ${t.containerName} 已消失，标 error 并摘流`,
      );
    }
    return marked;
  }

  /**
   * 生命周期取证器 die 事件即时对账：running 成员的容器意外死亡秒级摘流，
   * 不等周期对账。计划内的主动收割（remove/isolate 重物化）发生时成员状态
   * 已不是 running，天然跳过——只有「意外死亡」会被标记。
   */
  noteMemberContainerDeath(containerName: string, verdict: string): void {
    for (const branch of this.opts.state.getAllBranches()) {
      for (const rs of Object.values(branch.replicaSets ?? {})) {
        const m = rs.members.find((x) => x.containerName === containerName);
        if (!m) continue;
        if (m.status !== 'running') return;
        this.patchMember(branch.id, rs.profileId, m.id, {
          status: 'error',
          statusMessage: `副本容器死亡：${verdict}——已从入口分流摘除`,
        });
        this.opts.logger?.warn?.(
          `[replica-set] 副本死亡即时摘流：${branch.id}/${rs.profileId}/${m.id}（${containerName}）${verdict}`,
        );
        return;
      }
    }
  }

  /** 启动即对账一次（收敛 CDS 停机期间的死亡），此后周期兜底。 */
  startMemberReconcileLoop(intervalMs = 60_000): void {
    const run = () => void this.reconcileMembersAgainstDocker().catch((err) => {
      this.opts.logger?.warn?.(`[replica-set] 副本对账异常: ${(err as Error).message}`);
    });
    run();
    const timer = setInterval(run, intervalMs);
    (timer as { unref?: () => void }).unref?.();
  }

  startPlan(branchId: string, input: {
    onFailure: 'stop' | 'rollback';
    steps: Array<{ kind: ReplicaPlanStepKind; profileId: string; params?: ReplicaPlanStep['params'] }>;
    /** 管理模式二选一（2026-07-24 用户拍板）：首次保存计划钉住，副本清零前不许换 */
    mode?: 'container' | 'project';
  }): ReplicaPlan {
    const branch = this.requireBranch(branchId);
    if ((branch.replicaPlans || []).some((p) => p.status === 'running')) {
      throw new ReplicaSetError(409, '已有执行中的变更计划，请等它结束或取消后再保存新计划');
    }
    // 存量分支兜底：模式字段面世前创建的副本都是逐容器操作的产物 → 默认钉容器级，
    // 防止旧分支仍可两级混管（模式二选一对存量同样生效）
    if (!branch.replicaMode && this.totalMemberCount(branch) > 0) branch.replicaMode = 'container';
    if (input.mode === 'container' || input.mode === 'project') {
      const total = this.totalMemberCount(branch);
      if (branch.replicaMode && branch.replicaMode !== input.mode && total > 0) {
        throw new ReplicaSetError(409,
          `复制集管理模式二选一：该分支已按${branch.replicaMode === 'container' ? '容器级' : '项目级'}管理（还有 ${total} 个副本）。关闭全部复制集后才能切换`);
      }
      branch.replicaMode = input.mode;
    }
    if (!input.steps.length) throw new ReplicaSetError(400, '计划为空');
    if (input.steps.length > 20) throw new ReplicaSetError(400, '单个计划最多 20 步');
    const kinds: ReplicaPlanStepKind[] = ['add-replica', 'remove-member', 'set-weight', 'isolate-db', 'revert-db', 'dissolve'];
    for (const s of input.steps) {
      if (!kinds.includes(s.kind)) throw new ReplicaSetError(400, `未知步骤类型: ${s.kind}`);
      if (!s.profileId) throw new ReplicaSetError(400, '步骤缺少 profileId');
    }
    const plan: ReplicaPlan = {
      id: `rsplan_${this.now().replace(/[^0-9]/g, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 7)}`,
      branchId,
      status: 'running',
      onFailure: input.onFailure === 'rollback' ? 'rollback' : 'stop',
      steps: input.steps.map((s, i) => ({
        id: `step_${i + 1}`, kind: s.kind, profileId: s.profileId, params: s.params, status: 'pending' as const,
      })),
      createdAt: this.now(),
    };
    branch.replicaPlans = [plan, ...(branch.replicaPlans || [])].slice(0, 20);
    this.opts.state.save();
    void this.runPlan(branchId, plan.id);
    return plan;
  }

  listPlans(branchId: string): ReplicaPlan[] {
    return this.requireBranch(branchId).replicaPlans || [];
  }

  /** 执行中重排剩余步骤：orderedPendingIds 是全部 pending 步骤 id 的新顺序 */
  reorderPlan(branchId: string, planId: string, orderedPendingIds: string[]): ReplicaPlan {
    const plan = this.requirePlan(branchId, planId);
    if (plan.status !== 'running') throw new ReplicaSetError(409, '计划已结束，无法调序');
    const pending = plan.steps.filter((s) => s.status === 'pending');
    const set = new Set(pending.map((s) => s.id));
    if (orderedPendingIds.length !== pending.length || orderedPendingIds.some((id) => !set.has(id))) {
      throw new ReplicaSetError(400, '调序清单必须恰好覆盖全部待执行步骤');
    }
    const byId = new Map(plan.steps.map((s) => [s.id, s]));
    const nonPending = plan.steps.filter((s) => s.status !== 'pending');
    plan.steps = [...nonPending, ...orderedPendingIds.map((id) => byId.get(id)!)];
    this.opts.state.save();
    return plan;
  }

  skipStep(branchId: string, planId: string, stepId: string): ReplicaPlan {
    const plan = this.requirePlan(branchId, planId);
    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) throw new ReplicaSetError(404, `步骤不存在: ${stepId}`);
    if (step.status !== 'pending') throw new ReplicaSetError(409, '只有待执行的步骤可以跳过');
    step.status = 'skipped';
    step.endedAt = this.now();
    this.opts.state.save();
    return plan;
  }

  /** 取消剩余 pending 步骤；当前 running 步骤不中断（容器操作不可安全打断），跑完即收尾 */
  cancelPlan(branchId: string, planId: string): ReplicaPlan {
    const plan = this.requirePlan(branchId, planId);
    if (plan.status !== 'running') throw new ReplicaSetError(409, '计划已结束');
    for (const s of plan.steps) {
      if (s.status === 'pending') { s.status = 'cancelled'; s.endedAt = this.now(); }
    }
    this.opts.state.save();
    return plan;
  }

  private requirePlan(branchId: string, planId: string): ReplicaPlan {
    const plan = (this.requireBranch(branchId).replicaPlans || []).find((p) => p.id === planId);
    if (!plan) throw new ReplicaSetError(404, `计划不存在: ${planId}`);
    return plan;
  }

  private savePlan(): void { this.opts.state.save(); }

  private async runPlan(branchId: string, planId: string): Promise<void> {
    const log = (m: string) => this.opts.logger?.info?.(`[replica-plan] ${branchId}/${planId} ${m}`);
    try {
      for (;;) {
        const plan = this.requirePlan(branchId, planId);
        const next = plan.steps.find((s) => s.status === 'pending');
        if (!next) break;
        next.status = 'running';
        next.startedAt = this.now();
        this.savePlan();
        log(`执行 ${next.id} ${next.kind}(${next.profileId})`);
        try {
          await this.executeStep(branchId, next);
          next.status = 'done';
          next.endedAt = this.now();
          this.savePlan();
        } catch (err) {
          next.status = 'error';
          next.error = (err as Error).message.slice(0, 600);
          next.endedAt = this.now();
          for (const s of plan.steps) {
            if (s.status === 'pending') { s.status = 'cancelled'; s.endedAt = this.now(); }
          }
          this.savePlan();
          log(`步骤失败: ${next.error}`);
          if (plan.onFailure === 'rollback') {
            // 回滚失败不许谎报成功（Codex P1）：任一步回滚失败（如副本容器移除
            // 抛错，成员记录与分流权重仍然活着）→ 计划终态是 error 而非
            // rolled-back，rollbackLog 里有逐步真相
            const allRolledBack = await this.rollbackPlan(branchId, planId);
            const p2 = this.requirePlan(branchId, planId);
            p2.status = allRolledBack ? 'rolled-back' : 'error';
            if (!allRolledBack) {
              p2.rollbackLog = p2.rollbackLog || [];
              p2.rollbackLog.push('部分步骤回滚失败，现场未完全还原——请按上方日志逐项人工核对');
            }
            p2.endedAt = this.now();
          } else {
            plan.status = 'error';
            plan.endedAt = this.now();
          }
          this.savePlan();
          return;
        }
      }
      const plan = this.requirePlan(branchId, planId);
      plan.status = plan.steps.some((s) => s.status === 'cancelled') ? 'cancelled' : 'done';
      plan.endedAt = this.now();
      this.savePlan();
      log(`计划结束: ${plan.status}`);
    } catch (err) {
      // 引擎级异常（分支被删等）：尽力标记
      try {
        const plan = this.requirePlan(branchId, planId);
        plan.status = 'error';
        plan.endedAt = this.now();
        this.savePlan();
      } catch { /* branch gone */ }
      this.opts.logger?.warn?.(`[replica-plan] 引擎异常 ${branchId}/${planId}: ${(err as Error).message}`);
    }
  }

  private async executeStep(branchId: string, step: ReplicaPlanStep): Promise<void> {
    const { profileId } = step;
    if (step.kind === 'add-replica') {
      if (!this.requireBranch(branchId).replicaSets?.[profileId]?.enabled) this.enable(branchId, profileId);
      const member = this.addMember(branchId, profileId, {
        versionId: step.params?.versionId || undefined,
        dbMode: step.params?.dbMode === 'isolated' ? 'isolated' : 'shared',
      });
      step.resultMemberId = member.id;
      this.savePlan();
      await this.waitFor(branchId, step.params?.dbMode === 'isolated' ? 900_000 : 300_000, () => {
        const m = this.findMember(branchId, profileId, member.id);
        if (!m) throw new Error('成员在等待期间消失');
        if (m.status === 'error') throw new Error(m.statusMessage || '成员启动失败');
        return m.status === 'running';
      });
      return;
    }
    if (step.kind === 'remove-member') {
      const memberId = step.params?.memberId;
      if (!memberId) throw new Error('缺少 memberId');
      await this.removeMember(branchId, profileId, memberId);
      return;
    }
    if (step.kind === 'set-weight') {
      const memberId = step.params?.memberId;
      const weight = step.params?.weight;
      if (!memberId || typeof weight !== 'number') throw new Error('缺少 memberId / weight');
      const rs = this.requireBranch(branchId).replicaSets?.[profileId];
      if (!rs) throw new Error('该服务未启用复制集');
      step.prevWeight = memberId === 'primary' ? rs.primaryWeight : this.findMember(branchId, profileId, memberId)?.weight;
      this.savePlan();
      this.updateMember(branchId, profileId, memberId, { weight });
      return;
    }
    if (step.kind === 'isolate-db') {
      const before = (this.requireBranch(branchId).replicaSets?.[profileId]?.members || [])
        .filter((m) => m.status === 'running').map((m) => m.id);
      const r = this.isolateProfile(branchId, profileId);
      if (!r.accepted) throw new Error(r.reason || '隔离未被接受');
      await this.waitFor(branchId, 1_500_000, () => {
        const rs = this.requireBranch(branchId).replicaSets?.[profileId];
        const errored = rs?.members.find((m) => m.status === 'error');
        if (errored) throw new Error(errored.statusMessage || '隔离失败');
        return !!rs?.isolated && before.every((id) => this.findMember(branchId, profileId, id)?.status === 'running');
      });
      return;
    }
    if (step.kind === 'revert-db') {
      const r = this.revertProfile(branchId, profileId);
      if (!r.accepted) throw new Error(r.reason || '回切未被接受');
      await this.waitFor(branchId, 600_000, () => {
        const rs = this.requireBranch(branchId).replicaSets?.[profileId];
        const errored = rs?.members.find((m) => m.status === 'error');
        if (errored) throw new Error(errored.statusMessage || '回切失败');
        return !rs?.isolated && (rs?.members || []).every((m) => m.status !== 'provisioning');
      });
      return;
    }
    // dissolve
    await this.dissolve(branchId, profileId);
  }

  /**
   * 逆序回滚已完成步骤（不可回滚的步骤记日志跳过）。
   * 返回是否全部成功回滚（Codex P1）：任一步失败必须让调用方把计划标 error，
   * 不许在副本/权重仍然活着时对操作员谎报「已回滚」。
   */
  private async rollbackPlan(branchId: string, planId: string): Promise<boolean> {
    const plan = this.requirePlan(branchId, planId);
    plan.rollbackLog = plan.rollbackLog || [];
    let allOk = true;
    const done = plan.steps.filter((s) => s.status === 'done').reverse();
    for (const s of done) {
      try {
        if (s.kind === 'add-replica' && s.resultMemberId) {
          // 不吞错：removeMember 抛错（容器移除失败时成员记录与权重仍在）要走
          // 外层 catch 记日志并把 allOk 翻 false，该步保持 done 不标 rolled-back
          await this.removeMember(branchId, s.profileId, s.resultMemberId);
          plan.rollbackLog.push(`回滚 ${s.id}: 已下线副本 ${s.resultMemberId}`);
          s.status = 'rolled-back';
        } else if (s.kind === 'set-weight' && typeof s.prevWeight === 'number' && s.params?.memberId) {
          const rs = this.requireBranch(branchId).replicaSets?.[s.profileId];
          if (rs && (s.params.memberId === 'primary' || this.findMember(branchId, s.profileId, s.params.memberId))) {
            this.updateMember(branchId, s.profileId, s.params.memberId, { weight: s.prevWeight });
            plan.rollbackLog.push(`回滚 ${s.id}: 权重恢复为 ${s.prevWeight}`);
            s.status = 'rolled-back';
          }
        } else if (s.kind === 'isolate-db') {
          const r = this.revertProfile(branchId, s.profileId);
          if (r.accepted) {
            await this.waitFor(branchId, 600_000, () => {
              const rs = this.requireBranch(branchId).replicaSets?.[s.profileId];
              return !rs?.isolated && (rs?.members || []).every((m) => m.status !== 'provisioning');
            }).catch(() => undefined);
            plan.rollbackLog.push(`回滚 ${s.id}: 已回切主库（隔离库转快照保留）`);
            s.status = 'rolled-back';
          } else {
            plan.rollbackLog.push(`回滚 ${s.id} 失败: ${r.reason}`);
            allOk = false;
          }
        } else {
          plan.rollbackLog.push(`步骤 ${s.id}(${s.kind}) 不可自动回滚，保持现状`);
        }
      } catch (err) {
        plan.rollbackLog.push(`回滚 ${s.id} 异常: ${(err as Error).message.slice(0, 200)}`);
        allOk = false;
      }
      this.savePlan();
    }
    return allOk;
  }

  private findMember(branchId: string, profileId: string, memberId: string): ReplicaMember | undefined {
    return this.opts.state.getBranch(branchId)?.replicaSets?.[profileId]?.members.find((m) => m.id === memberId);
  }

  /** 3s 轮询直到条件满足；条件函数抛错 = 步骤失败；超时抛错 */
  private async waitFor(branchId: string, timeoutMs: number, check: () => boolean): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (check()) return;
      if (Date.now() > deadline) throw new Error(`等待终态超时（${Math.round(timeoutMs / 1000)}s）`);
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }

  private async removeMemberContainer(member: ReplicaMember): Promise<void> {
    if (member.containerName) {
      await this.opts.container.remove(member.containerName, {
        actor: 'replica-set',
        trigger: 'replica-set-remove',
      });
    }
    member.status = 'stopped';
  }

  private requireBranch(branchId: string): BranchEntry {
    const branch = this.opts.state.getBranch(branchId);
    if (!branch) throw new ReplicaSetError(404, `分支不存在: ${branchId}`);
    return branch;
  }

  private requireProfile(branch: BranchEntry, profileId: string): BuildProfile {
    const profile = this.opts.state
      .getEffectiveProfilesForBranch(branch)
      .find((p) => p.id === profileId);
    if (!profile) throw new ReplicaSetError(404, `服务不存在: ${profileId}`);
    return resolveEffectiveProfile(profile, branch);
  }

  private async collectListeningPorts(): Promise<Set<number>> {
    const result = await this.opts.shell.exec('ss -H -ltn').catch(() => null);
    if (!result || result.exitCode !== 0) return new Set();
    const ports = new Set<number>();
    for (const line of result.stdout.split('\n')) {
      const match = line.match(/:(\d+)\s/);
      if (match) ports.add(Number(match[1]));
    }
    return ports;
  }
}

export class ReplicaSetError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ReplicaSetError';
  }
}

function clampWeight(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}
