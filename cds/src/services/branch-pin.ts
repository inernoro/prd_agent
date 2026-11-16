import type { BranchPin } from '../types.js';
import { isAuthenticatedHuman, isHumanSystemOwner } from './human-auth.js';

export const DEFAULT_PIN_SECONDS = 24 * 3600;
export const MAX_PIN_SECONDS = 7 * 24 * 3600;
export interface PinRequest { permanent?: unknown; ttlSeconds?: unknown; reason?: unknown; authorizationRef?: unknown }

/** Protection receipts use authenticated middleware stamps, never impersonation/trigger headers. */
export function branchPinActor(request: unknown): string {
  const auth = request as { cdsUser?: { id?: string; username?: string; githubLogin?: string }; cdsProjectKey?: { id?: string; projectId?: string }; cdsAgentGlobalKey?: { id?: string } };
  if (isAuthenticatedHuman(request)) return `human:${auth.cdsUser?.id || auth.cdsUser?.username || auth.cdsUser?.githubLogin || 'authenticated'}`;
  if (auth.cdsProjectKey) return `project-automation:${auth.cdsProjectKey.projectId || 'unknown'}:${auth.cdsProjectKey.id || 'unattributed'}`;
  return `global-automation:${auth.cdsAgentGlobalKey?.id || 'unattributed'}`;
}

/** Invalid or missing old metadata never withdraws protection. */
export function pinExpired(pin: BranchPin | undefined, now = Date.now()): boolean {
  if (!pin || pin.kind !== 'temporary' || pinNeedsReview(pin)) return false;
  const created = Date.parse(pin.createdAt), expires = Date.parse(pin.expiresAt || '');
  return Number.isFinite(created) && Number.isFinite(expires) && expires - created >= 60000
    && expires - created <= MAX_PIN_SECONDS * 1000 && now >= created && now >= expires;
}

export function createBranchPin(body: PinRequest, request: unknown, actor: string, now = Date.now()): BranchPin {
  if (body.permanent !== undefined && typeof body.permanent !== 'boolean') throw new Error('permanent 必须是 boolean');
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (body.permanent) {
    if (!isHumanSystemOwner(request)) throw new Error('永久固定须由已登录的系统所有者明确授权');
    const authorizationRef = typeof body.authorizationRef === 'string' ? body.authorizationRef.trim() : '';
    if (!reason || !authorizationRef || body.ttlSeconds !== undefined) throw new Error('永久固定必须提供原因和授权依据，且不能同时设置期限');
    if (reason.length > 500 || authorizationRef.length > 500) throw new Error('固定原因或授权依据过长');
    return { kind: 'permanent', createdAt: new Date(now).toISOString(), actor, reason, authorizationRef };
  }
  const ttl = body.ttlSeconds ?? DEFAULT_PIN_SECONDS;
  if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 60 || ttl > MAX_PIN_SECONDS) throw new Error('临时固定期限须为 60 秒到 7 天');
  if (reason.length > 500) throw new Error('固定原因过长');
  return { kind: 'temporary', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + ttl * 1000).toISOString(),
    actor, reason: reason || '临时调试保护' };
}

/** Agent cannot replace/revoke a legacy, permanent, or another actor's protection. */
export function mayChangePin(enabled: boolean | undefined, pin: BranchPin | undefined, request: unknown, actor: string): boolean {
  return !enabled || isHumanSystemOwner(request) || Boolean(!pinNeedsReview(pin) && pin?.kind === 'temporary' && pin.actor === actor);
}

export function reviewedConfigPin(pin: (BranchPin & { configuredBranches: string[] }) | undefined, configured: readonly string[]): BranchPin | undefined {
  return typeof pin?.authorizationRef === 'string' && pin.authorizationRef.trim() && Array.isArray(pin.configuredBranches)
    && JSON.stringify([...pin.configuredBranches].sort()) === JSON.stringify([...configured].sort()) ? pin : undefined;
}

export function pinNeedsReview(pin: BranchPin | undefined): boolean {
  if (!pin || typeof pin.actor !== 'string' || !pin.actor.trim() || typeof pin.reason !== 'string' || !pin.reason.trim()
    || typeof pin.createdAt !== 'string' || !Number.isFinite(Date.parse(pin.createdAt))) return true;
  if (pin.kind === 'permanent') return typeof pin.authorizationRef !== 'string' || !pin.authorizationRef.trim();
  if (typeof pin.expiresAt !== 'string') return true;
  const duration = Date.parse(pin.expiresAt || '') - Date.parse(pin.createdAt);
  return pin.kind !== 'temporary' || !Number.isFinite(duration) || duration < 60000 || duration > MAX_PIN_SECONDS * 1000;
}
