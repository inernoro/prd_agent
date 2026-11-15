import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import React, { act } from 'react';

test('运维只显示当前状态和有效操作；无流量不判失败，旧发布参数不重新展示验收记录', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/governance?releaseCommit=old-release' });
  const names = ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent'];
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  for (const name of names) globalThis[name] = dom.window[name];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import('react-dom/client');
  const router = await import('react-router-dom');
  globalThis.__governanceRouter = { ...router.default, ...router };
  globalThis.__governanceFixture = { role: 'owner', failAuthority: false, calls: [] };
  const api = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true }, ssr: { noExternal: ['react-router-dom'] },
    plugins: [{ name: 'governance-state-fixture', enforce: 'pre',
      resolveId(id) { if (id === 'react-router-dom') return '\0governance-router'; },
      load(id) {
        if (id === '\0governance-router') return Object.keys(globalThis.__governanceRouter).filter(name => name !== 'default').map(name => `export const ${name}=globalThis.__governanceRouter.${name};`).join('\n');
        if (id.endsWith('/src/lib/auth.tsx')) return 'export function useAuth(){return {tenant:{role:globalThis.__governanceFixture.role}}}';
        if (id.endsWith('/src/lib/api.ts')) return [...api.matchAll(/^export (?:async )?function (\w+)/gm)].map(([, name]) => {
          if (name === 'getConfigAuthorityReport') return 'export async function getConfigAuthorityReport(){return globalThis.__governanceFixture.failAuthority?{success:false,error:{message:"配置状态暂不可用"}}:{success:true,data:{summary:{status:"blocked",mapOnlyPools:99,mapOnlyPlatforms:0,mapOnlyModels:2,mapOnlyExchanges:0,activeMissingGatewayPool:3},gaps:[{detail:"内部迁移报告不应展示"}]}}}';
          if (name === 'getKeyHealth') return 'export async function getKeyHealth(){return {success:true,data:{summary:{status:"ok",ok:2,unreadable:0,missing:0}}}}';
          if (name === 'getProtocolCoverage') return 'export async function getProtocolCoverage(params){globalThis.__governanceFixture.calls.push(params);return {success:true,data:{sinceHours:24,items:[{ingressProtocol:"openai-compatible",label:"OpenAI-compatible",status:"no-evidence",logRequests:0,httpRequests:0,failedRequests:0,droppedParameterRequests:0,requestTypes:[],missingActiveAppCallerCodes:["internal-old-sample"],logsLink:"/logs?ingressProtocol=openai-compatible",appCallersLink:"/app-callers"}]}}}';
          return `export async function ${name}(){return {success:true,data:{items:[],total:4}}}`;
        }).join('\n');
      },
    }],
  });
  let root;
  try {
    const { GovernancePage } = await server.ssrLoadModule('/src/pages/OverviewPage.tsx');
    root = createRoot(document.getElementById('root'));
    const mount = key => act(async () => root.render(React.createElement(globalThis.__governanceRouter.MemoryRouter, {}, React.createElement(GovernancePage, { key }))));
    await mount('owner');
    assert.match(document.body.textContent, /3 个活跃调用方尚无可用模型/);
    assert.match(document.body.textContent, /有 2 项已有 MAP 配置可导入/);
    assert.match(document.body.textContent, /暂无请求/);
    assert.ok([...document.querySelectorAll('button')].some(el => el.textContent === '导入已有配置'));
    assert.ok(document.querySelector('a[href="/logical-models"]'));
    assert.ok(document.querySelector('a[href="/logs?ingressProtocol=openai-compatible"]'));
    assert.doesNotMatch(document.body.textContent, /发布 Gate|权威迁移|容器拓扑|缺样本|内部迁移报告|internal-old-sample|无证据|old-release/);
    assert.deepEqual(globalThis.__governanceFixture.calls[0], { sinceHours: 24 });
    globalThis.__governanceFixture.role = 'viewer';
    await mount('viewer');
    assert.ok(![...document.querySelectorAll('button')].some(el => el.textContent === '导入已有配置'));
    assert.match(document.body.textContent, /当前角色可以查看状态/);
    globalThis.__governanceFixture.failAuthority = true;
    await mount('unavailable');
    assert.match(document.body.textContent, /调用方路由状态暂不可用/);
    assert.doesNotMatch(document.body.textContent, /0 个活跃调用方尚无可用模型/);
  } finally {
    if (root) await act(async () => root.unmount());
    await server.close(); dom.window.close();
    for (const name of names) globalThis[name] = previous[name];
    delete globalThis.__governanceFixture; delete globalThis.__governanceRouter;
  }
});
