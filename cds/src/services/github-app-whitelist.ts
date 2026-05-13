import type { GithubAppWhitelistSettings, GithubWebhookDelivery, Project } from '../types.js';

export interface GitHubOwnerPolicy {
  allowedOwners: string[];
}

export interface GitHubOwnerDecision {
  allowed: boolean;
  owner?: string;
  reason: string;
}

export function normalizeGitHubOwner(owner: string): string {
  return owner.trim().replace(/^@/, '').toLowerCase();
}

export function normalizeGitHubOwnerList(owners: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const owner of owners) {
    const normalized = normalizeGitHubOwner(owner);
    if (!normalized || seen.has(normalized)) continue;
    if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

export function ownerFromRepoFullName(repoFullName: string | undefined): string | undefined {
  if (!repoFullName) return undefined;
  const idx = repoFullName.indexOf('/');
  if (idx <= 0) return undefined;
  return repoFullName.slice(0, idx);
}

export function getGithubAppWhitelistSettings(
  settings: GithubAppWhitelistSettings | undefined,
): GithubAppWhitelistSettings {
  return {
    allowedOwners: normalizeGitHubOwnerList(settings?.allowedOwners || []),
  };
}

export function evaluateGitHubOwner(
  input: { repoFullName?: string; owner?: string },
  settings: GithubAppWhitelistSettings | undefined,
): GitHubOwnerDecision {
  const resolvedOwner = input.owner || ownerFromRepoFullName(input.repoFullName);
  const owner = resolvedOwner ? normalizeGitHubOwner(resolvedOwner) : undefined;
  const allowedOwners = getGithubAppWhitelistSettings(settings).allowedOwners;
  if (!owner) {
    return { allowed: false, reason: 'GitHub payload 缺少 repository owner,已按白名单策略拦截' };
  }
  if (allowedOwners.length === 0) {
    return {
      allowed: true,
      owner,
      reason: `CDS GitHub App 白名单为空,owner '${owner}' 默认放行`,
    };
  }
  if (!allowedOwners.includes(owner)) {
    return {
      allowed: false,
      owner,
      reason: `GitHub owner '${owner}' 不在 CDS GitHub App 白名单`,
    };
  }
  return { allowed: true, owner, reason: `GitHub owner '${owner}' 已通过白名单` };
}

export function summarizeGithubOwners(
  deliveries: GithubWebhookDelivery[],
  projects: Project[],
): Array<{ owner: string; count: number; blockedCount: number; linked: boolean; lastSeenAt?: string }> {
  const map = new Map<string, { owner: string; count: number; blockedCount: number; linked: boolean; lastSeenAt?: string }>();
  const touch = (ownerRaw: string | undefined, patch?: { blocked?: boolean; linked?: boolean; seenAt?: string }) => {
    const owner = ownerRaw ? normalizeGitHubOwner(ownerRaw) : '';
    if (!owner) return;
    const cur = map.get(owner) || { owner, count: 0, blockedCount: 0, linked: false };
    cur.count += patch?.seenAt ? 1 : 0;
    cur.blockedCount += patch?.blocked ? 1 : 0;
    cur.linked = cur.linked || patch?.linked === true;
    if (patch?.seenAt && (!cur.lastSeenAt || Date.parse(patch.seenAt) > Date.parse(cur.lastSeenAt))) {
      cur.lastSeenAt = patch.seenAt;
    }
    map.set(owner, cur);
  };

  for (const project of projects) {
    touch(ownerFromRepoFullName(project.githubRepoFullName), { linked: true });
  }
  for (const item of deliveries) {
    touch(item.githubOwner || ownerFromRepoFullName(item.repoFullName), {
      blocked: item.githubWhitelistDecision === 'blocked',
      seenAt: item.receivedAt,
    });
  }

  return [...map.values()].sort((a, b) => {
    if (a.blockedCount !== b.blockedCount) return b.blockedCount - a.blockedCount;
    return (Date.parse(b.lastSeenAt || '') || 0) - (Date.parse(a.lastSeenAt || '') || 0);
  });
}
