import type { EnvAuditFact } from '../shared/engineering-planning.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { BuildProfile, EnvChangeLogEntry } from '../types.js';
import { isAuthenticatedHuman } from './human-auth.js';
import { establishAgentOperationContext } from './agent-operation-context.js';
import { resolveEffectiveProfile } from './container.js';
import type { StateService } from './state.js';

type OperatorRequest = Request & { cdsUser?: { id: string; name?: string; username?: string };
  cdsProjectKey?: { keyId: string; projectId: string }; _aiSession?: { agentName?: string } };

const validKey = (key: string) => /^[A-Za-z_][A-Za-z0-9_.-]{0,199}$/.test(key)
  && !Object.hasOwn(Object.prototype, key);
const missingSession = '请求没有可验证的智能体会话声明';

export function appendEnvironmentAudit(state: StateService, req: Request, scope: string, op: EnvChangeLogEntry['op'],
  before: Record<string, string>, after: Record<string, string>, touched?: string[], options: { rotation?: boolean; profileId?: string } = {}) {
  const global = scope === '_global';
  const project = state.getProject(scope);
  const branch = project ? undefined : state.getBranch(scope);
  const projectId = global ? scope : project?.id ?? (branch && (branch.projectId || 'default'));
  if (!projectId || project?.mirror || branch?.mirror) return;
  const { identity, operationId, requestId } = establishAgentOperationContext(req);
  const stamps = req as OperatorRequest;
  const projectKey = stamps.cdsProjectKey;
  const key = projectKey && state.getAgentKeys(projectKey.projectId).find(item => item.id === projectKey.keyId);
  const actor = key ? key.label : isAuthenticatedHuman(req) && stamps.cdsUser
    ? stamps.cdsUser.name || stamps.cdsUser.username || stamps.cdsUser.id : stamps._aiSession?.agentName;
  const signer = key?.claimedBy || key?.createdBy;
  const isMachine = Boolean(key || stamps._aiSession);
  const keys = [...new Set(touched ?? [...Object.keys(before), ...Object.keys(after)])].filter(validKey);
  if (!keys.length) return;
  const explanation = identity.operationReason;
  const note = explanation && ![...Object.values(before), ...Object.values(after)]
    .some(value => typeof value === 'string' && value !== '' && explanation.includes(value)) ? explanation : undefined;
  const ts = new Date().toISOString();
  const facts = keys.map((key): EnvAuditFact => {
    const had = Object.hasOwn(before, key), has = Object.hasOwn(after, key);
    const disposition = had && !has ? 'deleted' : !had && has ? 'added'
      : before[key] === after[key] ? 'unchanged' : options.rotation ? 'rotated' : 'changed';
    const effect: EnvAuditFact['effect'] = disposition === 'unchanged' ? { state: 'not-applicable' }
      : global ? { state: 'unknown', reason: '全局配置影响多个服务，请核对对应服务的生效记录' }
        : options.profileId && op === 'delete' && !branch ? { state: 'unknown', reason: '构建配置已删除，请核对相关容器的清理记录' } : { state: 'pending' };
    return { eventId: randomUUID(), projectId, scope: global ? 'global' : options.profileId ? 'profile' : branch ? 'branch' : 'project',
      profileId: options.profileId, branchId: branch?.id, ts, key, disposition,
      actor, actorReason: actor ? undefined : '请求没有可验证的操作者名称', requestId, operationId,
      signer, signerReason: isMachine && !signer ? '使用的凭据没有登记签发人' : undefined,
      sessionId: isMachine ? identity.agentSessionId : undefined, sessionReason: !isMachine ? '真人操作' : identity.agentSessionId ? undefined : missingSession,
      threadId: isMachine ? identity.threadId : undefined, turnId: isMachine ? identity.turnId : undefined, skillName: isMachine ? identity.skillName : undefined,
      skillVersion: isMachine ? identity.skillVersion : undefined, note, effect };
  });
  state.appendEnvChangeLog(projectId, { op, keys, actor, source: 'api', facts });
}

export function environmentAuditFacts(state: StateService, projectId: string, branchId?: string, includeArchive = false,
  relatedLegacyKeys?: ReadonlySet<string>): EnvAuditFact[] {
  const visible = includeArchive ? undefined : new Set(state.getEnvChangeLog(projectId, false, 2000));
  let completed: ReturnType<StateService['getDeploymentRuns']> | undefined;
  return state.getEnvChangeLog(projectId, true).flatMap((entry, index): EnvAuditFact[] => {
    if (visible && !visible.has(entry)) return [];
    if (entry.facts) return entry.facts.filter(fact => !branchId || branchId === fact.branchId);
    if (branchId && !entry.keys.some(key => relatedLegacyKeys?.has(key))) return [];
    completed ??= state.getDeploymentRuns({ projectId, status: 'running' }).filter(run => run.finishedAt)
      .sort((a, b) => a.finishedAt!.localeCompare(b.finishedAt!));
    const candidate = completed.find(run => run.finishedAt! > entry.ts);
    if (branchId && candidate?.branchId !== branchId) return [];
    const effect: EnvAuditFact['effect'] = candidate ? { state: 'inferred', runId: candidate.id, at: candidate.finishedAt,
      reason: '记录之后该项目最早的一次成功部署，旧留痕没有绑定生效证据' } : { state: 'unknown', reason: '历史留痕没有绑定部署运行' };
    return entry.keys.filter(key => validKey(key) && (!branchId || relatedLegacyKeys?.has(key))).map(key => ({
      eventId: createHash('sha256').update(JSON.stringify([projectId, entry.ts, index, key])).digest('hex').slice(0, 24),
      projectId, key, ts: entry.ts, actor: entry.actor,
      actorReason: !entry.actor ? '历史留痕没有记录操作者' : ['智能体', 'agent', 'ai'].includes(entry.actor) ? '历史留痕没有记录具体智能体身份' : undefined,
      signerReason: '历史留痕没有记录签发人', disposition: 'unknown',
      branchReason: branchId ? '历史留痕缺少分支信息，按本分支后续部署提供线索' : '历史留痕缺少分支信息',
      dispositionReason: '历史留痕没有比较写入前后的值', sessionReason: '历史留痕没有记录会话',
      effect,
    }));
  });
}

/** Capture immutable event identities while the deploy inputs still describe current configuration. */
export function freezeEnvironmentAudit(state: StateService, projectId: string, branchId: string,
  configuredEnv?: Record<string, string>, profiles?: BuildProfile[], profileId?: string) {
  const branch = state.getBranch(branchId);
  const resolved = branch ? (profiles ?? state.getEffectiveProfilesForBranch(branch))
    .filter(profile => !profileId || profile.id === profileId).map(profile => resolveEffectiveProfile(profile, branch)) : [];
  const projectEnv = state.getCustomEnvScope(projectId);
  const branchEnv = state.getCustomEnvScope(branchId);
  const latest = new Map<string, EnvAuditFact>();
  for (const fact of environmentAuditFacts(state, projectId, undefined, true)) {
    if ((fact.branchId && fact.branchId !== branchId) || fact.disposition === 'unchanged' || fact.disposition === 'unknown') continue;
    latest.set(JSON.stringify([fact.branchId, fact.profileId, fact.key]), fact);
  }
  return [...latest.values()].filter(fact => {
    if (fact.effect.state !== 'pending') return false;
    if (fact.profileId) {
      const target = resolved.find(profile => profile.id === fact.profileId);
      const original = fact.branchId && branch
        ? state.getEffectiveProfilesForBranch(branch).find(profile => profile.id === fact.profileId)
        : state.getBuildProfile(fact.profileId);
      const expected = fact.branchId && branch && original ? resolveEffectiveProfile(original, branch) : original;
      return Boolean(target && expected && Object.hasOwn(expected.env ?? {}, fact.key) === Object.hasOwn(target.env ?? {}, fact.key)
        && expected.env?.[fact.key] === target.env?.[fact.key]);
    }
    if (!fact.branchId && Object.hasOwn(branchEnv, fact.key)) return false;
    if (fact.branchId && fact.disposition === 'deleted' && Object.hasOwn(projectEnv, fact.key)) return false;
    const own = fact.branchId ? branchEnv : projectEnv;
    if (resolved.some(profile => Object.hasOwn(profile.env ?? {}, fact.key)
      && (fact.disposition === 'deleted' || profile.env![fact.key] !== own[fact.key]))) return false;
    if (!configuredEnv) return true;
    return Object.hasOwn(own, fact.key) === Object.hasOwn(configuredEnv, fact.key) && own[fact.key] === configuredEnv[fact.key];
  }).map(fact => fact.eventId);
}
