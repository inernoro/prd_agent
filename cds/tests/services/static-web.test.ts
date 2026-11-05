import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { StaticWebService } from '../../src/services/static-web.js';

let directory: string;
let manager: StaticWebService;
const identity = { projectId: 'project', branchId: 'branch', profileId: 'web' };
const image = `sha256:${'a'.repeat(64)}`;
const revision = 'b'.repeat(40);

async function bundle(destination: string, base = '/') {
  await fs.mkdir(path.join(destination, 'assets'), { recursive: true });
  await fs.writeFile(path.join(destination, 'index.html'), `<html><head><script src="${base}runtime-config.js"></script><script type="module" src="${base}assets/index-12345678.js"></script></head><body>实际静态页面</body></html>`);
  await fs.writeFile(path.join(destination, 'assets/index-12345678.js'), 'export const value = 1;');
  await fs.writeFile(path.join(destination, 'runtime-config.json'), JSON.stringify({ VITE_API_BASE_URL: '/api' }));
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-static-web-'));
  manager = new StaticWebService({ rootDirectory: directory,
    exportFiles: async (_image, _imagePath, destination) => bundle(destination), resolveUpstream: () => undefined });
});

afterEach(async () => { await manager.close(); await fs.rm(directory, { recursive: true, force: true }); });

function prepare(extra = {}) {
  return manager.prepare({ identity, serviceName: 'site', image, revision,
    config: { imagePath: '/usr/share/nginx/html', runtimeConfig: true },
    env: { VITE_API_BASE_URL: '/actual/api', PASSWORD: 'must-never-be-exported' }, check: () => {}, ...extra });
}

describe('非容器静态预览实际HTTP行为', () => {
  it('从真实文件提供页面和资源，SPA刷新正常，缺失资源保持404及正确缓存/MIME', async () => {
    const runtime = await prepare();
    const port = await manager.start(runtime, 0);
    const base = `http://127.0.0.1:${port}`;
    const home = await fetch(`${base}/products/123`);
    expect(home.status).toBe(200); expect(await home.text()).toContain('实际静态页面');
    expect(home.headers.get('cache-control')).toBe('no-cache');
    const script = await fetch(`${base}/assets/index-12345678.js`);
    expect(script.status).toBe(200); expect(script.headers.get('content-type')).toMatch(/javascript/);
    expect(script.headers.get('cache-control')).toContain('immutable');
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/missing.css`)).status).toBe(404);
    expect((await fetch(`${base}/.cds-static-owner.json`)).status).toBe(404);
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405);
  });

  it('只注入构建声明的浏览器设置，运行配置禁止缓存', async () => {
    const runtime = await prepare(); const port = await manager.start(runtime, 0);
    const response = await fetch(`http://127.0.0.1:${port}/runtime-config`);
    const body = await response.text();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toContain('javascript');
    expect(body).toContain('/actual/api'); expect(body).not.toContain('must-never-be-exported');
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toContain('src="/runtime-config"');
  });

  it('供应商路径挂载后，深链和资源仍读取同一份产物', async () => {
    manager = new StaticWebService({ rootDirectory: directory,
      exportFiles: async (_image, _imagePath, destination) => bundle(destination, '/vendor/'), resolveUpstream: () => undefined });
    const runtime = await prepare({ config: { imagePath: '/app/dist', basePath: '/vendor/' } });
    const port = await manager.start(runtime, 0);
    expect((await fetch(`http://127.0.0.1:${port}/vendor/orders/123`)).status).toBe(200);
    expect(await (await fetch(`http://127.0.0.1:${port}/vendor/assets/index-12345678.js`)).text()).toContain('export const');
    expect((await fetch(`http://127.0.0.1:${port}/outside`)).status).toBe(404);
  });

  it('无效新版不会破坏旧版，停止后可按原身份和端口恢复', async () => {
    const old = await prepare(); const port = await manager.start(old, 0);
    const broken = new StaticWebService({ rootDirectory: directory, exportFiles: async (_i, _p, target) => {
      await fs.writeFile(path.join(target, 'index.html'), '<script src="missing.js"></script>');
    }, resolveUpstream: () => undefined });
    await expect(broken.prepare({ identity, serviceName: 'broken', image, revision,
      config: { imagePath: '/dist' }, env: {}, check: () => {} })).rejects.toThrow('脚本不存在');
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    await manager.stop(old.id); expect(manager.has(old.id)).toBe(false);
    await manager.start(old, port); expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    await expect(manager.start({ ...old, branchId: 'other' }, port)).rejects.toThrow('归属不匹配');
  });

  it('符号链接和可变镜像不能成为公网文件', async () => {
    await expect(prepare({ image: 'nginx:latest' })).rejects.toThrow('不可变');
    const outside = path.join(directory, 'private'); await fs.writeFile(outside, 'private-value');
    const malicious = new StaticWebService({ rootDirectory: path.join(directory, 'malicious'), resolveUpstream: () => undefined,
      exportFiles: async (_i, _p, target) => { await bundle(target); await fs.symlink(outside, path.join(target, 'leak.js')); } });
    await expect(malicious.prepare({ identity, serviceName: 'bad', image, revision,
      config: { imagePath: '/dist' }, env: {}, check: () => {} })).rejects.toThrow('文件类型');
    expect(await fs.readFile(outside, 'utf8')).toBe('private-value');
  });

  it('独立入口的API按明确规则转发，后端不可用时不把API伪装成SPA', async () => {
    const backend = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ path: req.url })); });
    await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
    const backendPort = (backend.address() as import('node:net').AddressInfo).port;
    const resolve = vi.fn(() => ({ host: '127.0.0.1', port: backendPort }));
    const proxy = new StaticWebService({ rootDirectory: path.join(directory, 'proxy'),
      exportFiles: async (_i, _p, destination) => bundle(destination), resolveUpstream: resolve });
    try {
      const runtime = await proxy.prepare({ identity, serviceName: 'proxy', image, revision,
        config: { imagePath: '/dist', proxyRules: [{ pathPrefix: '/api', profileId: 'backend' }] }, env: {}, check: () => {} });
      const port = await proxy.start(runtime, 0);
      expect(await (await fetch(`http://127.0.0.1:${port}/api/items?page=1`)).json()).toEqual({ path: '/api/items?page=1' });
      expect(resolve).toHaveBeenCalledWith(expect.objectContaining(identity), 'backend');
      resolve.mockReturnValue(undefined as never);
      expect((await fetch(`http://127.0.0.1:${port}/api/items`)).status).toBe(503);
    } finally { await proxy.close(); await new Promise<void>(resolve => backend.close(() => resolve())); }
  });
});
