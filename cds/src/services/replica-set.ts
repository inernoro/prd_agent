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
  ServiceState,
} from '../types.js';
import type { StateService } from './state.js';
import type { ContainerService } from './container.js';
import { resolveEffectiveProfile } from './container.js';
import type { DeploymentVersionService } from './deployment-version.js';
import { cloneReplicaDb, dropReplicaDb, resolveReplicaDbTarget } from './replica-db-clone.js';

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
    this.opts.state.save();
    this.opts.logger?.info?.(`[replica-set] 解散 ${branchId}/${profileId}（退回普通模式）`);
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
    rs.updatedAt = this.now();
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
    const used = (branch.replicaDbSnapshots ?? [])
      .map((s) => /^guard-(\d+)$/.exec(s.memberId)?.[1]).filter(Boolean).map(Number);
    const guardId = `guard-${used.length ? Math.max(...used) + 1 : 1}`;
    void cloneReplicaDb({
      target,
      memberId: guardId,
      profileId,
      now: this.opts.now,
      onOutput: (line) => onStage('cloning', line),
    }).then((cloned) => {
      const liveBranch = this.requireBranch(branchId);
      liveBranch.replicaDbSnapshots = [...(liveBranch.replicaDbSnapshots || []), cloned.snapshot];
      this.opts.state.save();
      onStage('done', `隔离副本 ${cloned.snapshot.dbName} 已就绪（来源 ${cloned.snapshot.sourceDb}）`, cloned.snapshot.dbName);
    }).catch((err) => {
      onStage('error', (err as Error).message);
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
    const rs = branch.replicaSets?.[profileId];
    if (!rs?.enabled) return { accepted: false, reason: '该服务未启用复制集' };
    if (rs.isolated) return { accepted: false, reason: '已处于隔离状态' };
    const members = rs.members.filter((m) => m.status === 'running');
    if (members.length === 0) return { accepted: false, reason: '没有运行中的副本可切换' };
    const baseProfile = this.requireProfile(branch, profileId);
    const { target, reason } = resolveReplicaDbTarget(this.opts.state, branch, baseProfile);
    if (!target) return { accepted: false, reason: `无法定位数据库：${reason}` };
    const used = [
      ...(branch.replicaDbSnapshots ?? []).map((s) => s.memberId),
    ].map((mid) => /^guard-(\d+)$/.exec(mid)?.[1]).filter(Boolean).map(Number);
    const guardId = `guard-${used.length ? Math.max(...used) + 1 : 1}`;
    for (const m of members) {
      this.patchMember(branchId, profileId, m.id, { status: 'provisioning', statusMessage: '第1步 复制：正在克隆隔离库…' });
    }
    void (async () => {
      try {
        const cloned = await cloneReplicaDb({
          target, memberId: guardId, profileId, now: this.opts.now,
          // 复验 R5-P1：克隆保护/进度必须有用户可见 sink——透传到成员 statusMessage
          //（保持「第1步」前缀，UI 的隔离阶段判定依赖它）+ 服务端日志
          onOutput: (line) => {
            this.opts.logger?.info?.(`[replica-set] ${branchId}/${profileId} ${line}`);
            for (const m of members) {
              this.patchMember(branchId, profileId, m.id, { statusMessage: `第1步 复制：${line.slice(0, 200)}` });
            }
          },
        });
        const live = this.requireBranch(branchId);
        live.replicaDbSnapshots = [...(live.replicaDbSnapshots || []), cloned.snapshot];
        const liveRs = live.replicaSets![profileId];
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
    const currentMember = this.opts.state.getBranch(branchId)?.replicaSets?.[profileId]?.members
      .find((m) => m.id === memberId);
    if (!dbOverride && currentMember?.dbMode === 'isolated') {
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
          now: this.opts.now,
          onOutput,
        });
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
