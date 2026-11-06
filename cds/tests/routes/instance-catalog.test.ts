import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
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
  it.each(['https://user:secret@backup.example', 'javascript:alert(1)', 'https://backup.example/project-list', 'https://backup.example/?key=secret', 'http://backup.example'])('拒绝不安全或有歧义的地址 %s', url => {
    expect(() => parseInstanceCatalog({ version: 1, instances: [{ ...entry, url }] })).toThrow();
  });
  it('拒绝重复标识或地址；不把源实例项目 ID 带到目标', () => {
    expect(() => parseInstanceCatalog({ version: 1, instances: [entry, entry] })).toThrow();
    const catalog = parseInstanceCatalog({ version: 1, instances: [entry] });
    expect(instanceConsoleUrl(catalog.instances[0])).toBe('https://backup.example/project-list');
  });
});
