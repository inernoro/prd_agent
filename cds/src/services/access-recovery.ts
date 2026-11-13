import { createHash, timingSafeEqual } from 'node:crypto';
import type { StateService } from './state.js';
import { credentialUsability, hasActiveGrant } from './identity.js';
import { isHumanProjectGrantUpdatePending } from './human-project-access.js';

export type AccessRecoveryState = 'ready' | 'approval-required' | 'credential-unusable'
  | 'account-disabled' | 'project-access-revoked' | 'access-update-pending';

/** 原权限收回期间只报告状态；不签发、不续期、不恢复授权。 */
export function principalRecoveryBlock(state: StateService, principalId: string, projectId: string): AccessRecoveryState | undefined {
  if (isHumanProjectGrantUpdatePending(state, principalId)) return 'access-update-pending';
  const principal = state.getPrincipal(principalId);
  if (!principal || principal.status !== 'active') return 'account-disabled';
  const grants = state.getProjectGrants();
  if (!hasActiveGrant(grants, principalId, projectId)
    && grants.some(g => g.principalId === principalId && g.projectId === projectId && g.revokedAt)) return 'project-access-revoked';
  return undefined;
}

function matches(hash: string, candidate: Buffer): boolean {
  const stored = Buffer.from(hash, 'hex');
  return stored.length === candidate.length && timingSafeEqual(stored, candidate);
}

/** 已停用的凭据只能证明恢复对象，不能因此获得任何项目操作权限。 */
export function inspectAccessRecovery(state: StateService, projectId: string, plaintext: string): {
  state: AccessRecoveryState; principalId?: string; kind: 'user' | 'project';
} | undefined {
  if (!plaintext.startsWith('cdsu_') && !plaintext.startsWith('cdsp_')) return undefined;
  const hash = createHash('sha256').update(plaintext).digest();
  const kind = plaintext.startsWith('cdsu_') ? 'user' : 'project';
  const credential = kind === 'user'
    ? state.getUserCredentials().find(c => matches(c.hash, hash))
    : state.getProject(projectId)?.agentKeys?.find(c => matches(c.hash, hash));
  if (!credential) return undefined;
  if ('projectIds' in credential && credential.projectIds && !credential.projectIds.includes(projectId)) return undefined;
  const principalId = credential.principalId;
  if (kind === 'user' && !principalId) return { state: 'credential-unusable', kind };
  if (principalId) {
    const blocked = principalRecoveryBlock(state, principalId, projectId);
    if (blocked) return { state: blocked, principalId, kind };
  }
  if (!credentialUsability(credential, principalId ? state.getPrincipal(principalId) : undefined, Date.now(), !!principalId).usable) {
    return { state: 'credential-unusable', principalId, kind };
  }
  return { state: principalId && !hasActiveGrant(state.getProjectGrants(), principalId, projectId)
    ? 'approval-required' : 'ready', principalId, kind };
}

export function recoveryMessage(state: AccessRecoveryState): string {
  if (state === 'account-disabled') return '账号或主体已停用，请管理员在原管理页面恢复；Agent 会自动继续原项目，不需要复制密钥。';
  if (state === 'project-access-revoked') return '原项目权限已收回，请管理员在原管理页面恢复该项目授权；Agent 会自动继续，不会另建项目。';
  if (state === 'access-update-pending') return '访问状态正在保存或恢复，Agent 会等待确认后继续。';
  return '原项目访问状态已核对。';
}
