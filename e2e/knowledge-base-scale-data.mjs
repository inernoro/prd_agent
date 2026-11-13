/** 只在非生产预览创建本人私有的隔离样本；未知写入回执不自动重发或删除。
 * 代理环境使用 Node 24+ 并设置 NODE_USE_ENV_PROXY=1，保留系统 CA 环境。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const base = process.env.E2E_BASE_URL;
const out = process.env.OUT_DIR || '/tmp/kb-scale-data';
if (!base || !process.env.MAP_USER || !process.env.MAP_PASSWORD) throw Error('需要 E2E_BASE_URL / MAP_USER / MAP_PASSWORD');
if (process.env.MAP_PROD_HOST && new URL(base).host === new URL(process.env.MAP_PROD_HOST).host) throw Error('拒绝向正式环境写入规模样本');
fs.mkdirSync(out, { recursive: true });
const login = await (await fetch(new URL('/api/v1/auth/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: process.env.MAP_USER, password: process.env.MAP_PASSWORD, clientType: 'admin' }) })).json();
if (!login.success) throw Error(login.error?.message || '登录失败');
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.data.accessToken}` };
const actor = login.data.user.userId;
async function request(url, method = 'GET', body) {
  const r = await fetch(new URL(url, base), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(300000) });
  const result = await r.json();
  if (!r.ok || !result.success) throw Error(`${r.status}: ${result.error?.message || '请求失败'}`);
  return result.data;
}
const manifestFile = path.join(out, 'fixture.json');
if (process.argv.includes('--cleanup')) {
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  for (const store of manifest) {
    if (store.state !== 'complete' || store.base !== base || store.actor !== actor || !store.name.startsWith('规模验收隔离-')) throw Error('样本身份或完整回执不符，保留数据供人工核对');
    const actual = await request(`/api/document-store/stores/${store.id}`);
    if (actual.ownerId !== actor || actual.name !== store.name || !actual.tags?.includes(store.runId)) throw Error('当前归属与 manifest 不符，拒绝删除');
    await request(`/api/document-store/stores/${store.id}`, 'DELETE');
    store.state = 'deleted';
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  }
  console.log('已删除 manifest 中全部已确认的本人隔离空间');
  process.exit(0);
}
if (!process.argv.includes('--apply')) throw Error('创建样本需显式 --apply；清理需同一 OUT_DIR 与 --cleanup');
if (fs.existsSync(manifestFile)) throw Error('已有 manifest，请先核对既有任务，禁止自动重建');
const runId = `kb-scale-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0,14)}-${crypto.randomBytes(3).toString('hex')}`;
const manifest = [];
for (const n of [200, 1000, 5000]) {
  const name = `规模验收隔离-${n}-${runId}`;
  const record = { n, name, base, actor, runId, state: 'pending', expectedEntries: n + 10, tail: `tail-${n}-${n-1}` };
  manifest.push(record);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  for (let offset = 0; offset < n; offset += 250) {
    const folders = Array.from({ length: 10 }, (_, i) => ({ exportId: `folder-${i}`, isFolder: true, title: `目录 ${i}` }));
    const documents = Array.from({ length: Math.min(250, n - offset) }, (_, index) => {
      const i = offset + index;
      const content = `# 样本文档 ${String(i).padStart(5,'0')}\n\n${runId}\n\n` + '隔离规模样本正文，记录业务背景和处理办法。'.repeat(140) + `\n\n文末唯一词 tail-${n}-${i}\n`;
      return { exportId: `doc-${i}`, parentExportId: i % 5 === 0 ? `folder-${i % 10}` : undefined,
        title: `样本文档 ${String(i).padStart(5,'0')}`, sourceType: 'import', contentType: 'text/markdown', content, summary: content.slice(0,180) };
    });
    const result = await request('/api/document-store/stores/import', 'POST', { version: 1,
      store: { name, isPublic: false, tags: ['规模验收隔离', runId], description: '仅用于本分支规模验收，可按同一 manifest 审查后清理' }, entries: [...folders, ...documents] });
    record.id = result.storeId;
    record.acknowledgedDocuments = offset + documents.length;
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    if (result.failed !== 0) throw Error('导入有失败，保留 manifest 与已确认条目，不自动重发');
    console.log(`${n}: ${record.acknowledgedDocuments}/${n}`);
  }
  const items = [];
  let cursor;
  do {
    const params = new URLSearchParams({ all: 'true', navigation: 'true', pageSize: '500' });
    if (cursor) params.set('cursor', cursor);
    const page = await request(`/api/document-store/stores/${record.id}/entries?${params}`);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  if (new Set(items.map(e => e.id)).size !== record.expectedEntries) throw Error('回读条目数量不符，保留数据供核对');
  record.folderId = items.find(e => e.title === '目录 0')?.id;
  record.lastEntryId = items.find(e => e.title === `样本文档 ${String(n-1).padStart(5,'0')}`)?.id;
  if (!record.folderId || !record.lastEntryId) throw Error('关键条目回读缺失');
  record.state = 'complete';
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), { mode: 0o600 });
}
console.log(`隔离样本已确认：${manifestFile}`);
