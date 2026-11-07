import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createInstanceCatalogRouter } from '../../src/routes/instance-catalog.js';
import { instanceConsoleUrl, parseInstanceCatalog } from '../../src/shared/instance-catalog.js';

const roots: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});
const entry = { id: 'standby', name: '备用 CDS', role: 'standby', url: 'https://backup.example' };

describe('主备 CDS 目录', () => {
  it('真实服务器扁平发布入口在源码目录已退役后仍读取随产物保存的原目录', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-catalog-deployed-')); roots.push(root);
    const cds = path.join(root, 'cds'), dist = path.join(cds, 'dist'), web = path.join(cds, 'web', 'dist');
    fs.mkdirSync(dist, { recursive: true }); fs.mkdirSync(web, { recursive: true });
    fs.symlinkSync(fs.realpathSync(fileURLToPath(new URL('../../node_modules', import.meta.url))), path.join(root, 'node_modules'), 'dir');
    fs.writeFileSync(path.join(web, 'cds-instances.json'), JSON.stringify({ version: 1, instances: [{ ...entry, key: 'not-published' }] }));
    const source = fs.readFileSync(new URL('../../src/server.ts', import.meta.url), 'utf8');
    const registration = source.match(/app\.use\('\/api', createInstanceCatalogRouter\([\s\S]*?\)\);/)?.[0];
    expect(registration).toBeDefined();
    const input = path.join(root, 'server-registration.mjs'), output = path.join(dist, 'index.mjs');
    const repoRoot = path.join(root, 'retired-source');
    fs.writeFileSync(input, `import express from 'express'; import path from 'node:path'; import {fileURLToPath} from 'node:url';
      import {createInstanceCatalogRouter} from ${JSON.stringify(fileURLToPath(new URL('../../src/routes/instance-catalog.ts', import.meta.url)))};
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const deps = {config:{repoRoot:${JSON.stringify(repoRoot)}}}; const app = express();
      ${registration} export default app;`);
    await build({ entryPoints: [input], outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' });
    const { default: app } = await import(pathToFileURL(output).href);
    const server = app.listen(0, '127.0.0.1'); servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/instance-catalog`);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ version: 1, instances: [entry] });
    expect(fs.existsSync(path.join(repoRoot, 'cds-instances.json'))).toBe(false);
  });

  it('两端只读同一目录，响应不泄漏额外凭据字段，目录修改后立即生效', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-catalog-')); roots.push(root);
    const file = path.join(root, 'cds-instances.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, instances: [{ ...entry, key: 'secret' }] }));
    const bundled = path.join(root, 'bundled.json');
    const app = express(); app.use('/api', createInstanceCatalogRouter(root, bundled));
    const server = app.listen(0, '127.0.0.1'); servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/instance-catalog`;
    const response = await fetch(url);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ version: 1, instances: [entry] });
    fs.writeFileSync(file, '{broken');
    expect((await fetch(url)).status).toBe(503);
    fs.unlinkSync(file);
    expect(await (await fetch(url)).json()).toEqual({ version: 1, instances: [] });
    fs.writeFileSync(bundled, JSON.stringify({ version: 1, instances: [entry] }));
    expect(await (await fetch(url)).json()).toEqual({ version: 1, instances: [entry] });
  });
  it.each(['http://[::1]/', 'http://127.0.0.1/'])('保持已有本机 HTTP 地址 %s 可用', url => {
    const catalog = parseInstanceCatalog({ version: 1, instances: [{ ...entry, url }] });
    expect(catalog.instances[0].url).toBe(new URL(url).origin);
  });
  it.each(['https://user:secret@backup.example', 'javascript:alert(1)', 'https://backup.example/project-list', 'https://backup.example/?key=secret', 'http://backup.example', 'http://[2001:db8::1]/'])('拒绝不安全或有歧义的地址 %s', url => {
    expect(() => parseInstanceCatalog({ version: 1, instances: [{ ...entry, url }] })).toThrow();
  });
  it('拒绝重复标识或地址；不把源实例项目 ID 带到目标', () => {
    expect(() => parseInstanceCatalog({ version: 1, instances: [entry, entry] })).toThrow();
    const catalog = parseInstanceCatalog({ version: 1, instances: [entry] });
    expect(instanceConsoleUrl(catalog.instances[0])).toBe('https://backup.example/project-list');
  });
});
