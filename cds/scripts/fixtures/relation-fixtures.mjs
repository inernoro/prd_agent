/*
 * 关系视图视觉审计（relation-visual-audit.mjs）用的服务图样本。全部合成，不存真实快照
 * （约定见同目录 mobile-layout-fixtures.mjs 文件头）。
 *
 * - shape-alpha：与用户 2026-09-30 截图那条分支同构，来自 tests/web/fixtures/relation-shape-alpha.json，
 *   几何测试（tests/web/relation-geometry.test.ts）读的是同一份文件；
 * - dense：往坏里造——长服务名、两排前缀成员、十几个子域、双公网面、被多方调用的内网服务、
 *   基础设施依赖、跨项目引用（含断裂）、错误 / 警告 / 建议三种问题；
 * - minimal：一个壳一个成员；
 * - subs-only：主域名一个服务都没有，只有子域。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHAPE_FILE = path.resolve(HERE, '../../tests/web/fixtures/relation-shape-alpha.json');

const svcNode = (id, role, extra = {}) => ({ id: `service:${id}`, rawId: id, name: id, kind: 'service', role, roleSource: 'declared', ...extra });
const summary = (findings) => ({ errors: findings.filter((f) => f.severity === 'error').length, warnings: findings.filter((f) => f.severity === 'warn').length, infos: findings.filter((f) => f.severity === 'info').length });
const wrap = (graph, findings, references = []) => ({ branchId: 'fixture-branch-alpha', projectId: 'fixture-project', branch: 'feature/alpha', status: 'running', graph, lint: { findings, summary: summary(findings) }, references });

function dense() {
  const members = ['notification-dispatch-gateway', 'billing-settlement-service', 'search-indexer-api', 'media-transcode-api', 'auth-session-api', 'report-export-api', 'tenant-admin-api', 'audit-trail-api', 'feature-flag-api'];
  const subs = ['console', 'partner-portal', 'billing-settlement-service', 'open-api-docs', 'status-page', 'merchant-onboarding-wizard', 'worker-email', 'worker-sms', 'worker-webhook-retry', 'worker-pdf-render', 'worker-image-thumbnail', 'worker-search-reindex', 'cron-ledger-reconcile'];
  const subShell = (s) => (s === 'billing-settlement-service' ? s : `${s}-web`);
  const internal = ['shared-config-center', 'ledger-core-engine'];
  const nodes = [
    svcNode('storefront-web-shell', 'web', { pathPrefixes: ['/'] }),
    ...members.map((m) => svcNode(m, 'api', { pathPrefixes: [`/api/${m}/`, `/${m}/v2/`] })),
    ...subs.filter((s) => s !== 'billing-settlement-service').map((s) => svcNode(subShell(s), s.startsWith('worker') || s.startsWith('cron') ? 'worker' : 'web', { subdomain: s })),
    svcNode('partner-portal-api', 'api', { pathPrefixes: ['/partner-api/'] }),
    ...internal.map((m) => svcNode(m, 'api')),
    { id: 'infra:postgres-main', name: 'postgres-main', kind: 'infra', dockerImage: 'postgres:16' },
    { id: 'infra:redis-cache', name: 'redis-cache', kind: 'infra', dockerImage: 'redis:7' },
    { id: 'infra:rabbitmq-bus', name: 'rabbitmq-bus', kind: 'infra', dockerImage: 'rabbitmq:3' },
    { id: 'infra:minio-objects', name: 'minio-objects', kind: 'infra', dockerImage: 'minio/minio' },
  ];
  const e = (a, b, keys = []) => ({ from: `service:${a}`, to: b.startsWith('infra:') ? b : `service:${b}`, envKeys: keys, dependsOn: keys.length === 0 });
  const edges = [
    e('storefront-web-shell', 'auth-session-api'),
    e('report-export-api', 'search-indexer-api', ['SEARCH_URL']),
    e('feature-flag-api', 'notification-dispatch-gateway', ['NOTIFY_URL']),
    e('console-web', 'tenant-admin-api', ['ADMIN_API']),
    e('worker-email-web', 'notification-dispatch-gateway'),
    e('partner-portal-web', 'partner-portal-api'),
    e('billing-settlement-service', 'ledger-core-engine', ['LEDGER_URL']),
    e('audit-trail-api', 'ledger-core-engine'),
    e('tenant-admin-api', 'shared-config-center'),
    e('search-indexer-api', 'shared-config-center'),
    e('billing-settlement-service', 'infra:postgres-main', ['DATABASE_URL']),
    e('auth-session-api', 'infra:redis-cache', ['REDIS_URL']),
    e('worker-webhook-retry-web', 'infra:rabbitmq-bus', ['AMQP_URL']),
    e('media-transcode-api', 'infra:minio-objects', ['S3_ENDPOINT']),
    e('report-export-api', 'infra:postgres-main', ['DATABASE_URL']),
  ];
  const sites = [
    { id: 'main', kind: 'main', shellId: 'storefront-web-shell', shellSource: 'declared', members: members.map((m, i) => ({ id: m, prefixes: [`/api/${m}/`, `/${m}/v2/`], viaConvention: i === 7 })), conflicts: [] },
    ...subs.map((s) => ({ id: `sub:${s}`, kind: 'subdomain', subdomain: s, shellId: subShell(s), shellSource: 'declared', members: s === 'partner-portal' ? [{ id: 'partner-portal-api', prefixes: ['/partner-api/'] }] : [], conflicts: [] })),
  ];
  const findings = [
    { rule: 'prefix-conflict', severity: 'error', services: ['search-indexer-api', 'report-export-api'], message: 'search-indexer-api 与 report-export-api 都声明了前缀 /api/search-indexer-api/，同一个请求会被两个服务抢，实际落到哪一个取决于路由表的顺序', fix: '保留一个服务的前缀，另一个改成更具体的路径，例如 /api/report-export-api/search/' },
    { rule: 'double-public-surface', severity: 'warn', services: ['billing-settlement-service'], message: 'billing-settlement-service 同时暴露在子域 billing-settlement-service 和主域名前缀 /api/billing-settlement-service/、/billing-settlement-service/v2/ 上，一个服务两个公网入口', fix: '二选一：只留子域（整站归它），或只留主域名前缀' },
    { rule: 'prefix-by-convention', severity: 'warn', services: ['audit-trail-api'], message: 'audit-trail-api 的前缀是按服务名兜底推出来的，compose 里没有声明', fix: '在 compose 里给它写上 cds.path-prefix' },
    { rule: 'role-by-name', severity: 'info', services: ['notification-dispatch-gateway', 'billing-settlement-service', 'search-indexer-api', 'media-transcode-api', 'auth-session-api', 'report-export-api', 'tenant-admin-api'], message: '7 个服务的角色靠服务名或默认值推断', fix: '给它们声明 cds.role: web / api / worker' },
  ];
  const references = [
    { profileId: 'tenant-admin-api', key: 'IDENTITY_PROVIDER_URL', kind: 'cds-ref', resolved: [{ url: null, status: 'running', target: { projectId: 'other-project', projectSlug: 'identity-platform', branchName: 'main', serviceId: 'identity-api' }, ref: { projectRef: 'identity-platform', serviceId: 'identity-api' } }] },
    { profileId: 'notification-dispatch-gateway', key: 'SMS_PROVIDER_URL', kind: 'cds-ref', resolved: [{ url: null, status: 'stopped', target: { projectId: 'sms-project', projectSlug: 'sms-gateway', branchName: 'release/2026-09', serviceId: 'sms-api' }, ref: { projectRef: 'sms-gateway', serviceId: 'sms-api' } }] },
  ];
  return wrap({ nodes, edges, layers: [], sites, internal }, findings, references);
}

function minimal() {
  return wrap({
    nodes: [svcNode('web', 'web', { pathPrefixes: ['/'] }), svcNode('api', 'api', { pathPrefixes: ['/api/'] })],
    edges: [{ from: 'service:web', to: 'service:api', envKeys: [], dependsOn: true }],
    layers: [],
    sites: [{ id: 'main', kind: 'main', shellId: 'web', shellSource: 'declared', members: [{ id: 'api', prefixes: ['/api/'] }], conflicts: [] }],
    internal: [],
  }, []);
}

function subsOnly() {
  const subs = ['admin', 'docs', 'worker-a', 'worker-b', 'grafana'];
  return wrap({
    nodes: subs.map((s) => svcNode(`${s}-svc`, s.startsWith('worker') ? 'worker' : 'web', { subdomain: s })),
    edges: [{ from: 'service:admin-svc', to: 'service:worker-a-svc', envKeys: ['QUEUE'], dependsOn: false }],
    layers: [],
    sites: subs.map((s) => ({ id: `sub:${s}`, kind: 'subdomain', subdomain: s, shellId: `${s}-svc`, shellSource: 'declared', members: [], conflicts: [] })),
    internal: [],
  }, [{ rule: 'no-main-shell', severity: 'info', services: [], message: '主域名没有任何服务', fix: '如需主域名入口，给一个 web 服务声明 cds.path-prefix: /' }]);
}

/** 本地用真实分支验：cdscli topology <分支 id> 的原样输出，或 service-graph 响应本身 */
export function loadSnapshot(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const d = raw.data ?? raw;
  return { branchId: 'fixture-branch-alpha', projectId: 'fixture-project', branch: d.branch ?? d.branchId, status: 'running', graph: d.graph, lint: d.lint, references: d.references ?? [] };
}

export function relationFixtures() {
  const shape = JSON.parse(fs.readFileSync(SHAPE_FILE, 'utf8'));
  delete shape._source;
  return { 'shape-alpha': shape, dense: dense(), minimal: minimal(), 'subs-only': subsOnly() };
}
