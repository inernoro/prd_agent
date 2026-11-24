import type { ServiceKeyItem } from './types';

export function serviceKeyValidity(key: Pick<ServiceKeyItem, 'enabled' | 'expiresAt'>, now = Date.now()) {
  if (!key.enabled) return { value: 'revoked', label: '已撤销', color: 'var(--text-muted)', bg: 'var(--bg-elevated)' };
  if (key.expiresAt) {
    const expires = new Date(key.expiresAt).getTime();
    if (!Number.isFinite(expires)) return { value: 'unknown', label: '有效期未知', color: 'var(--warn)', bg: 'var(--warn-bg)' };
    if (expires <= now) return { value: 'expired', label: '已过期', color: 'var(--warn)', bg: 'var(--warn-bg)' };
  }
  return { value: 'active', label: '有效', color: 'var(--ok)', bg: 'var(--ok-bg)' };
}
