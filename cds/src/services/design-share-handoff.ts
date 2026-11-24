import { createHmac } from 'node:crypto';
import type { DesignShareHandoffReceipt, DesignSharePreparation } from '../shared/design-workspace.js';

type Binding = { approverId: string; siteId: string; revisionId: string };
export type DesignShareHandoffConfig = {
  issuer: string;
  target: URL;
  key: Buffer;
  resolve: (projectId: string, designId: string, version: number, actorId: string) => Binding | undefined;
  now?: () => Date;
};

function trustedUrl(value?: string) {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) return undefined;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) return undefined;
  url.pathname = url.pathname.replace(/\/*$/, '/');
  return url;
}

function own(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key] : undefined;
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value) && value !== '.' && value !== '..';
}

export function designShareHandoffConfig(publicBaseUrl: string, env: NodeJS.ProcessEnv): DesignShareHandoffConfig | undefined {
  try {
    const issuer = trustedUrl(publicBaseUrl)?.origin;
    const target = trustedUrl(env.CDS_DESIGN_MAP_HANDOFF_BASE);
    const rawKey = env.CDS_DESIGN_MAP_HANDOFF_KEY ?? '';
    if (!issuer || !target || !/^[A-Za-z0-9_-]{43}$/.test(rawKey)) return undefined;
    const key = Buffer.from(rawKey, 'base64url');
    if (key.length !== 32 || key.toString('base64url') !== rawKey) return undefined;
    const bindings: unknown = JSON.parse(env.CDS_DESIGN_MAP_HANDOFF_BINDINGS ?? '{}');
    return { issuer, target, key, resolve: (projectId, designId, version, actorId) => {
      const project = own(bindings, projectId);
      const approverId = own(own(project, 'approvers'), actorId);
      const revision = own(own(own(project, 'revisions'), designId), String(version));
      const siteId = own(revision, 'siteId');
      const revisionId = own(revision, 'revisionId');
      if (identifier(approverId) && identifier(siteId) && identifier(revisionId)) return { approverId, siteId, revisionId };
    } };
  } catch { return undefined; }
}

export function issueDesignShareHandoff(config: DesignShareHandoffConfig, binding: Binding, projectId: string,
  designId: string, preparation: DesignSharePreparation, prototypeSha256: string): DesignShareHandoffReceipt {
  const iat = Math.floor((config.now?.() ?? new Date()).getTime() / 1000);
  const exp = iat + 300;
  const data = Buffer.from(JSON.stringify({ purpose: 'cds-fixed-design-share', issuer: config.issuer, audienceOrigin: config.target.origin,
    projectId, designId, preparationId: preparation.id, version: preparation.version, sourceCommit: preparation.sourceCommit,
    packageSha256: preparation.packageSha256, prototypeSha256, expiresInHours: preparation.expiresInHours,
    access: preparation.audience, ...binding, iat, exp })).toString('base64url');
  const signature = createHmac('sha256', config.key).update(data).digest('base64url');
  return { preparationId: preparation.id, destination: new URL('web-pages/cds-share', config.target).href,
    grant: `${data}.${signature}`, expiresAt: new Date(exp * 1000).toISOString() };
}
