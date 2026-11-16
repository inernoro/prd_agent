/** Explicit local-only API/UI/MCP/CLI drill. Uses disposable databases and fixture credentials. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { createServer, installSpaFallback } from '../src/server.js';
import { StateService } from '../src/services/state.js';
import { MockShellExecutor } from '../src/services/shell-executor.js';
import { WorktreeService } from '../src/services/worktree.js';
import type { CdsConfig, Project } from '../src/types.js';
import type { ServerEventLogSink, ServerEventRecord } from '../src/services/server-event-log-store.js';
const folder = process.env.DTS_DRILL_DIRECTORY;
if (!folder || !folder.startsWith('/tmp/')) throw new Error('A disposable DTS_DRILL_DIRECTORY under /tmp is required');
const root = path.join(folder, 'interfaces'); fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const auth = JSON.parse(fs.readFileSync(path.join(folder, 'engine-private.json'), 'utf8'));
const projectId = 'dts-interface-qa-v2', rootKey = 'dts_disposable_operator_fixture', projectKey = 'cdsp_dts_interface_disposable_fixture_v2';
Object.assign(process.env, { CDS_AUTH_MODE: 'basic', CDS_USERNAME: 'dts_qa', CDS_PASSWORD: 'dts_disposable_interface_password', CDS_AI_ACCESS_KEY: rootKey,
  CDS_SSO_ENABLED: '', CDS_PUBLIC_BASE_URL: 'http://127.0.0.1:18886', CDS_MONGO_URI: 'mongodb://127.0.0.1:18882', CDS_MONGO_DB: 'dts_controlplane_qa_v2' });
const state = new StateService(path.join(root, 'state.json'), root); state.load();
if (!state.getProject(projectId)) state.addProject({ id: projectId, slug: projectId, name: 'DTS 隔离验收', kind: 'git', gitRepoUrl: 'https://github.com/fixture/dts.git', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as Project);
if (!state.getAgentKeys(projectId).some(k => k.id === 'qa-key')) state.addAgentKey(projectId, { id: 'qa-key', label: 'disposable drill', hash: createHash('sha256').update(projectKey).digest('hex'), scope: 'rw', createdAt: new Date().toISOString() });
state.setCustomEnv({ SOURCE_URI: 'mongodb://127.0.0.1:18881', TARGET_URI: 'mongodb://127.0.0.1:18882', ENGINE_USER: auth.username, ENGINE_PASSWORD: auth.password }, projectId);
const file = path.join(root, 'events.jsonl');
if (!fs.existsSync(file)) fs.writeFileSync(file, '', { mode: 0o600 });
const sink: ServerEventLogSink = { record: row => fs.appendFileSync(file, JSON.stringify({ ...row, _id: randomUUID(), ts: new Date() }) + '\n'),
  recordImmediate: async row => sink.record(row), findRecent: async filter => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s) as ServerEventRecord).filter(row => !filter?.requestId || row.requestId === filter.requestId).slice(-(filter?.limit || 200)) };
const shell = new MockShellExecutor();
const config: CdsConfig = { repoRoot: root, worktreeBase: path.join(root, 'worktrees'), masterPort: 18886, workerPort: 18887, dockerNetwork: 'dts-local-drill', portStart: 19901, sharedEnv: {}, jwt: { secret: 'disposable', issuer: 'drill' }, mode: 'standalone', executorPort: 19900 };
const app = createServer({ stateService: state, shell, config, serverEventLogStore: sink, worktreeService: new WorktreeService(shell, root),
  containerService: { list: async () => [], listContainers: async () => [], getContainers: async () => [] } as never,
  proxyService: { getProxyLog: () => [], setOnProxyLog() {}, handleSwitchFromExpress() {} } as never, bridgeService: {} as never });
installSpaFallback(app);
const server = http.createServer(app); await new Promise<void>(resolve => server.listen(18886, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:18886';
async function call(route: string, body?: unknown, method = 'POST') {
  const r = await fetch(origin + '/api/dts' + route + '?projectId=' + projectId, { method, headers: { 'Content-Type': 'application/json', 'X-AI-Access-Key': rootKey }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`DTS fixture setup failed: ${r.status} ${await r.text()}`); return r.json();
}
await call('/engine', { baseUrl: 'http://127.0.0.1:18885', version: '3.0.0', usernameEnv: 'ENGINE_USER', passwordEnv: 'ENGINE_PASSWORD' }, 'PUT');
const fields = { _id: 'string', name: 'string', revision: 'int' };
const base = { database: 'dts_interfaces_qa_v2', collection: 'accounts', kind: 'mongo', contract: { id: 'account-profile', version: 1, accepts: [1], fields }, accountFields: ['name', 'revision'] };
for (const [port, records] of [[18881, [{ _id: 'existing', name: '正式资料', revision: 2 }, { _id: 'new', name: '新账号', revision: 1 }]], [18882, [{ _id: 'existing', name: '备用原值', revision: 1, localOnly: '必须保留' }, { _id: 'target-only', name: '备用验收数据', revision: 1 }]]] as const) {
  const c = new MongoClient('mongodb://127.0.0.1:' + port); try { await c.connect(); if (await c.db(base.database).collection(base.collection).countDocuments()) continue; await c.db(base.database).dropDatabase(); await c.db(base.database).collection(base.collection).insertMany(records as never); } finally { await c.close(); }
}
const connections = await call('/connections', undefined, 'GET');
let source = connections.connections.find((c: { uriEnv: string }) => c.uriEnv === 'SOURCE_URI');
let target = connections.connections.find((c: { uriEnv: string }) => c.uriEnv === 'TARGET_URI');
if (!source) source = (await call('/connections', { ...base, environmentRole: 'production', name: '正式账号资料', uriEnv: 'SOURCE_URI' })).connection;
if (!target) target = (await call('/connections', { ...base, environmentRole: 'standby', allowWrite: true, name: '备用账号资料', uriEnv: 'TARGET_URI' })).connection;
fs.mkdirSync(path.join(root, '.git'), { recursive: true }); fs.mkdirSync(path.join(root, '.cds'), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(root, '.cds/credentials.json'), JSON.stringify({ version: 1, host: origin, projectId, projectKey }), { mode: 0o600 });
fs.writeFileSync(path.join(folder, 'interface-context.json'), JSON.stringify({ origin, projectId, sourceId: source.id, targetId: target.id, workspace: root }), { mode: 0o600 });
console.log('Local DTS interface fixture ready on loopback 18886; no production services used');
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { server.closeAllConnections(); server.close(); void app.locals.dtsService.store.close().finally(() => process.exit(0)); });
