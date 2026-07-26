/**
 * 复制集数据库隔离 MECE 审计（2026-07-26，用户点名「隔离测过有效吗 + 没有可观测性」）。
 *
 * 原则：隔离是否有效**不能靠配置推断，必须实测**。审计把「隔离有效」拆成
 * 互斥且穷尽的五个检查面，每一面都是可机器核对的度量，不是主观判断：
 *
 *   A 意图面   控制面一致性（isolated 标记 / 快照台账 / 成员 dbMode）
 *   B 配置面   容器真身 env（docker inspect）：副本真的指隔离库、主实例仍指主库
 *   C 实例面   专用隔离实例活性（容器 running + 端口 TCP 可达）
 *   D 数据面   双向金丝雀实测：隔离库写入不出现在主库、主库写入不出现在隔离库
 *              + 克隆基线（隔离库确有数据）。写入用专用 collection，测完即删
 *   E 边界面   MECE 的「穷尽」要求把**没隔住的部分显式摆出来**：主实例仍连主库
 *              （debt #25）、redis 未隔离（debt #24）、其他无隔离服务写同一主库
 *              （debt #21）——这些不是 fail，是必须让用户看见的已知边界
 *
 * 未隔离时退化为「连接观测」：逐容器列出真实连接的库（同样来自 docker inspect，
 * 不是配置面猜测），解决「不知道每个容器现在连的是哪个库」的可观测性缺口。
 */
import type { ReplicaDbSnapshot } from '../types.js';
import type { StateService } from './state.js';
import { runDockerExec } from '../routes/infra-data.js';
import { mongoAdminEval, resolveReplicaDbTarget } from './replica-db-clone.js';

export type AuditVerdict = 'pass' | 'fail' | 'skip' | 'boundary' | 'info';

export interface IsolationAuditCheck {
  id: string;
  group: '意图面' | '配置面' | '实例面' | '数据面' | '边界面' | '连接观测';
  title: string;
  verdict: AuditVerdict;
  /** 已脱敏的度量证据（连接串凭据打码） */
  evidence: string;
}

export interface IsolationAuditReport {
  branchId: string;
  profileId: string;
  /** effective=核心检查全过 / broken=任一核心检查失败 / not-isolated=该服务未隔离（仅观测） */
  overall: 'effective' | 'broken' | 'not-isolated';
  checks: IsolationAuditCheck[];
  ranAt: string;
}

const DB_NAME_SAFE = /^[a-z0-9_]+$/i;

/** 连接串凭据打码：mongodb://user:pw@host → mongodb://***@host */
function maskConn(value: string): string {
  return value.replace(/\/\/[^@/]+@/g, '//***@');
}

/** docker inspect 容器真实 env → map。失败返回 null（证据里带原因）。 */
async function inspectContainerEnv(containerName: string): Promise<Record<string, string> | null> {
  const r = await runDockerExec(['inspect', '-f', '{{json .Config.Env}}', containerName], '', 30_000, 64 * 1024);
  if (r.code !== 0) return null;
  try {
    const arr = JSON.parse(r.stdout.trim()) as string[];
    const out: Record<string, string> = {};
    for (const line of arr) {
      const idx = line.indexOf('=');
      if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return out;
  } catch {
    return null;
  }
}

const tcpProbe = async (port: number): Promise<boolean> => {
  const { connect } = await import('node:net');
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (ok: boolean) => { if (!settled) { settled = true; sock.destroy(); resolve(ok); } };
    sock.setTimeout(1_500, () => done(false));
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
  });
};

/** 专用隔离实例（无鉴权 mongod）eval 通道 */
function isoInstanceEval(container: string, script: string): ReturnType<typeof runDockerExec> {
  return runDockerExec(['exec', '-i', container, 'mongosh', '--quiet', '--eval', script], '', 30_000, 16 * 1024);
}

function tailNumber(stdout: string): number {
  const m = /(-?\d+)\s*$/.exec((stdout || '').trim());
  return m ? Number(m[1]) : NaN;
}

export async function runIsolationAudit(
  state: StateService,
  branchId: string,
  profileId: string,
): Promise<IsolationAuditReport> {
  const branch = state.getBranch(branchId);
  if (!branch) throw new Error(`分支不存在: ${branchId}`);
  const rs = branch.replicaSets?.[profileId];
  const profile = state.getEffectiveProfilesForBranch(branch).find((p) => p.id === profileId);
  if (!profile) throw new Error(`服务不存在: ${profileId}`);
  const checks: IsolationAuditCheck[] = [];
  const ranAt = new Date().toISOString();
  const { target } = resolveReplicaDbTarget(state, branch, profile);

  const mainContainer = branch.services?.[profileId]?.containerName;
  const mainEnv = mainContainer ? await inspectContainerEnv(mainContainer) : null;
  const memberEnvs: Array<{ id: string; container: string; env: Record<string, string> | null }> = [];
  for (const m of rs?.members ?? []) {
    if (m.containerName) memberEnvs.push({ id: m.id, container: m.containerName, env: await inspectContainerEnv(m.containerName) });
  }

  // ── 未隔离：退化为连接观测（可观测性兜底，永远有产出）──
  if (!rs?.isolated) {
    const describe = (env: Record<string, string> | null): string => {
      if (!env) return '容器不可 inspect（可能已停止）';
      if (!target) return '未识别到数据库 env';
      const parts = target.envKeys.map((k) => `${k}=${env[k] ?? '(未设置)'}`);
      for (const k of target.connEnvKeys) if (env[k]) parts.push(`${k}=${maskConn(env[k])}`);
      return parts.join(' · ') || '未识别到数据库 env';
    };
    checks.push({
      id: 'O1', group: '连接观测', title: `主实例（${mainContainer ?? '无容器'}）当前连接`,
      verdict: 'info', evidence: describe(mainEnv),
    });
    for (const me of memberEnvs) {
      checks.push({
        id: `O-${me.id}`, group: '连接观测', title: `副本 ${me.id}（${me.container}）当前连接`,
        verdict: 'info', evidence: describe(me.env),
      });
    }
    checks.push({
      id: 'O2', group: '连接观测', title: '隔离状态',
      verdict: 'info', evidence: '该服务当前未隔离——主实例与全部副本连同一个主库（实测 env，非配置推断）',
    });
    return { branchId, profileId, overall: 'not-isolated', checks, ranAt };
  }

  // ── 已隔离：五面 MECE 实测 ──
  const snapshot: ReplicaDbSnapshot | undefined = (branch.replicaDbSnapshots ?? [])
    .find((s) => s.id === rs.isolated!.snapshotId);

  // A 意图面
  checks.push({
    id: 'A1', group: '意图面', title: '隔离标记与快照台账一致',
    verdict: snapshot ? 'pass' : 'fail',
    evidence: snapshot
      ? `isolated.dbName=${rs.isolated.dbName} · 快照 ${snapshot.id}（${snapshot.engine}，克隆于 ${snapshot.clonedAt}）`
      : `isolated 引用的快照 ${rs.isolated.snapshotId} 不在台账——控制面自相矛盾`,
  });
  const wrongMode = (rs.members ?? []).filter((m) => m.dbMode !== 'isolated' && m.status === 'running');
  checks.push({
    id: 'A2', group: '意图面', title: '全部运行中副本处于隔离模式',
    verdict: wrongMode.length === 0 ? 'pass' : 'fail',
    evidence: wrongMode.length === 0
      ? `${(rs.members ?? []).filter((m) => m.status === 'running').length} 个运行副本 dbMode 全部 isolated`
      : `以下运行副本仍是 shared 模式: ${wrongMode.map((m) => m.id).join(', ')}`,
  });

  if (!target || !snapshot) {
    return { branchId, profileId, overall: 'broken', checks, ranAt };
  }
  if (!DB_NAME_SAFE.test(snapshot.dbName) || !DB_NAME_SAFE.test(target.sourceDb)) {
    checks.push({ id: 'A3', group: '意图面', title: '库名安全字符集', verdict: 'fail', evidence: '库名含不安全字符，中止数据面实测' });
    return { branchId, profileId, overall: 'broken', checks, ranAt };
  }

  // B 配置面（容器真身 env）
  for (const me of memberEnvs) {
    if (!me.env) {
      checks.push({ id: `B1-${me.id}`, group: '配置面', title: `副本 ${me.id} 真实 env 指向隔离库`, verdict: 'fail', evidence: '容器不可 inspect（可能已停止）' });
      continue;
    }
    const dbKeyHits = target.envKeys.map((k) => `${k}=${me.env![k] ?? '(未设置)'}`);
    const dbOk = target.envKeys.every((k) => me.env![k] === snapshot.dbName);
    checks.push({
      id: `B1-${me.id}`, group: '配置面', title: `副本 ${me.id} 真实 env 指向隔离库 ${snapshot.dbName}`,
      verdict: dbOk ? 'pass' : 'fail', evidence: dbKeyHits.join(' · '),
    });
    if (snapshot.dedicatedContainer && snapshot.dedicatedHostPort) {
      const connOk = target.connEnvKeys.length > 0
        && target.connEnvKeys.every((k) => (me.env![k] ?? '').includes(`:${snapshot.dedicatedHostPort}`));
      checks.push({
        id: `B2-${me.id}`, group: '配置面', title: `副本 ${me.id} 连接串直连专用实例 :${snapshot.dedicatedHostPort}`,
        verdict: connOk ? 'pass' : 'fail',
        evidence: target.connEnvKeys.map((k) => `${k}=${maskConn(me.env![k] ?? '(未设置)')}`).join(' · ') || '无连接串 key',
      });
    }
  }
  const mainStillMain = mainEnv ? target.envKeys.every((k) => mainEnv[k] === target.sourceDb) : false;
  checks.push({
    id: 'B3', group: '配置面', title: `主实例真实 env 仍指主库 ${target.sourceDb}（隔离不改主实例）`,
    verdict: mainEnv ? (mainStillMain ? 'pass' : 'fail') : 'skip',
    evidence: mainEnv
      ? target.envKeys.map((k) => `${k}=${mainEnv[k] ?? '(未设置)'}`).join(' · ')
      : '主实例容器不可 inspect',
  });

  // C 实例面（mongo 专用实例通道）
  if (snapshot.dedicatedContainer) {
    const st = await runDockerExec(['inspect', '-f', '{{.State.Status}}', snapshot.dedicatedContainer], '', 20_000, 4 * 1024);
    const running = st.code === 0 && st.stdout.trim() === 'running';
    checks.push({
      id: 'C1', group: '实例面', title: `专用隔离实例 ${snapshot.dedicatedContainer} 运行中`,
      verdict: running ? 'pass' : 'fail', evidence: st.code === 0 ? `docker state=${st.stdout.trim()}` : '容器不存在',
    });
    const reachable = snapshot.dedicatedHostPort ? await tcpProbe(snapshot.dedicatedHostPort) : false;
    checks.push({
      id: 'C2', group: '实例面', title: `专用实例宿主端口 :${snapshot.dedicatedHostPort} TCP 可达`,
      verdict: reachable ? 'pass' : 'fail', evidence: reachable ? 'TCP connect 成功' : 'TCP connect 失败',
    });
  } else {
    checks.push({ id: 'C1', group: '实例面', title: '专用隔离实例', verdict: 'skip', evidence: `${snapshot.engine} 走共享实例内克隆通道，无专用实例` });
  }

  // D 数据面（双向金丝雀，mongo 引擎实测；写入 cds_isolation_canary，测完即删）
  if (snapshot.engine === 'mongo' && snapshot.dedicatedContainer) {
    const infraEnv = target.infra.env || {};
    const infraPort = target.infra.containerPort || 27017;
    const tokIso = `iso${Date.now().toString(36)}`;
    const tokMain = `main${Date.now().toString(36)}`;
    const isoDb = `db.getSiblingDB('${snapshot.dbName}')`;
    const mainDb = `db.getSiblingDB('${target.sourceDb}')`;
    try {
      const baseline = await isoInstanceEval(snapshot.dedicatedContainer,
        `print(Number(${isoDb}.getCollectionNames().length))`);
      const collCount = tailNumber(baseline.stdout);
      checks.push({
        id: 'D1', group: '数据面', title: '克隆基线：隔离库确有数据',
        verdict: baseline.code === 0 && collCount > 0 ? 'pass' : 'fail',
        evidence: baseline.code === 0 ? `隔离库 ${snapshot.dbName} collections=${collCount}` : '隔离库不可读',
      });

      // 正向：隔离库写入 → 主库必须查无
      const wIso = await isoInstanceEval(snapshot.dedicatedContainer,
        `${isoDb}.cds_isolation_canary.insertOne({t:'${tokIso}'}); print('ok')`);
      const rMain = await mongoAdminEval(target.infra.containerName, infraPort, infraEnv,
        `print(Number(${mainDb}.cds_isolation_canary.countDocuments({t:'${tokIso}'})))`);
      const fwdOk = wIso.code === 0 && rMain.code === 0 && tailNumber(rMain.stdout) === 0;
      checks.push({
        id: 'D2', group: '数据面', title: '正向隔离：写入隔离库的数据不出现在主库',
        verdict: fwdOk ? 'pass' : 'fail',
        evidence: wIso.code !== 0 ? '隔离库写入失败' : rMain.code !== 0 ? '主库读取失败'
          : `隔离库写入金丝雀 → 主库命中 ${tailNumber(rMain.stdout)} 条（期望 0）`,
      });

      // 反向：主库写入 → 隔离库必须查无
      const wMain = await mongoAdminEval(target.infra.containerName, infraPort, infraEnv,
        `${mainDb}.cds_isolation_canary.insertOne({t:'${tokMain}'}); print('ok')`);
      const rIso = await isoInstanceEval(snapshot.dedicatedContainer,
        `print(Number(${isoDb}.cds_isolation_canary.countDocuments({t:'${tokMain}'})))`);
      const revOk = wMain.code === 0 && rIso.code === 0 && tailNumber(rIso.stdout) === 0;
      checks.push({
        id: 'D3', group: '数据面', title: '反向隔离：写入主库的数据不出现在隔离库',
        verdict: revOk ? 'pass' : 'fail',
        evidence: wMain.code !== 0 ? '主库写入失败' : rIso.code !== 0 ? '隔离库读取失败'
          : `主库写入金丝雀 → 隔离库命中 ${tailNumber(rIso.stdout)} 条（期望 0）`,
      });
    } finally {
      // 金丝雀清理：两侧都删（失败不影响审计结论，集合只含审计数据）
      await isoInstanceEval(snapshot.dedicatedContainer,
        `${isoDb}.cds_isolation_canary.deleteMany({t:{$in:['${tokIso}','${tokMain}']}})`).catch(() => undefined);
      await mongoAdminEval(target.infra.containerName, infraPort, infraEnv,
        `${mainDb}.cds_isolation_canary.deleteMany({t:{$in:['${tokIso}','${tokMain}']}})`).catch(() => undefined);
    }
  } else {
    checks.push({
      id: 'D1', group: '数据面', title: '双向金丝雀实测',
      verdict: 'skip', evidence: `${snapshot.engine} 引擎的数据面金丝雀实测暂未实现（当前仅 mongo 专用实例通道）`,
    });
  }

  // E 边界面（MECE 穷尽：显式列出没隔住的部分——这不是 fail，是必须可见的事实）
  checks.push({
    id: 'E1', group: '边界面', title: '主实例仍连主库（debt #25）',
    verdict: 'boundary',
    evidence: '隔离目前只作用于副本；主实例改连隔离库需要部署主路径 env 覆写层，尚未落地。入口打到主实例的流量仍写主库',
  });
  if (mainEnv) {
    const redisKeys = Object.keys(mainEnv).filter((k) => /REDIS/i.test(k));
    const sharedRedis = redisKeys.filter((k) => memberEnvs.some((me) => me.env && me.env[k] === mainEnv[k]));
    if (sharedRedis.length > 0) {
      checks.push({
        id: 'E2', group: '边界面', title: 'Redis 未隔离（debt #24）',
        verdict: 'boundary',
        evidence: `主实例与副本共用同一 Redis（实测 env key: ${sharedRedis.join(', ')}）——隔离预览里的 redis 拷贝尚未有执行通道`,
      });
    }
  }
  const sameDbOthers: string[] = [];
  for (const p of state.getEffectiveProfilesForBranch(branch)) {
    if (p.id === profileId) continue;
    if (branch.replicaSets?.[p.id]?.isolated) continue;
    const other = resolveReplicaDbTarget(state, branch, p);
    if (other.target && other.target.sourceDb === target.sourceDb && other.target.engine === target.engine) {
      sameDbOthers.push(p.id);
    }
  }
  if (sameDbOthers.length > 0) {
    checks.push({
      id: 'E3', group: '边界面', title: '同库其他服务未隔离（debt #21）',
      verdict: 'boundary',
      evidence: `以下服务与本服务写同一个主库且未隔离: ${sameDbOthers.join(', ')}——整组真隔离归影子分支方向`,
    });
  }

  const core = checks.filter((c) => c.group !== '边界面' && c.verdict !== 'skip' && c.verdict !== 'info' && c.verdict !== 'boundary');
  const overall = core.every((c) => c.verdict === 'pass') ? 'effective' : 'broken';
  return { branchId, profileId, overall, checks, ranAt };
}
