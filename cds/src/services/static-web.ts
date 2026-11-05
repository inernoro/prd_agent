import express from 'express';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { StaticWebConfig, StaticWebRuntime } from '../types.js';

export interface StaticWebIdentity {
  projectId: string;
  branchId: string;
  profileId: string;
}

export interface StaticWebDependencies {
  rootDirectory: string;
  exportFiles(image: string, imagePath: string, destination: string, check: () => void, identity: StaticWebIdentity): Promise<void>;
  resolveUpstream(identity: StaticWebIdentity, profileId: string): { host: string; port: number } | undefined;
}

interface OpenSite {
  identity: StaticWebIdentity;
  runtime: StaticWebRuntime;
  port: number;
  server: http.Server;
}

const PUBLIC_KEY = /^VITE_[A-Z0-9_]+$/;
const URL_PREFIX = /^\/(?:[a-z0-9_~.-]+\/)*[a-z0-9_~.-]*$/i;
const MIME_ASSET = /\.(?:js|mjs|css|map|json|png|jpe?g|webp|avif|gif|svg|ico|woff2?|ttf|wasm)$/i;

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Image files are untrusted input. Never serve symlinks, devices or an export outside its owned directory. */
async function validateFiles(root: string, basePath: string): Promise<void> {
  let count = 0;
  let bytes = 0;
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) throw new Error('静态产物包含不支持的文件类型');
      if (++count > 20_000 || (bytes += stat.isFile() ? stat.size : 0) > 256 * 1024 * 1024) throw new Error('静态产物超过文件或容量限额');
      if (stat.isDirectory()) { await fs.chmod(file, 0o755); await visit(file); }
      else if (entry.name !== '.cds-static-owner.json') await fs.chmod(file, 0o644);
    }
  }
  await visit(root);
  const html = await fs.readFile(path.join(root, 'index.html'), 'utf8');
  if (!html.trim()) throw new Error('静态产物缺少有效首页');
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)]
    .map(match => match[1]).filter(value => !/^(?:[a-z]+:)?\/\//i.test(value) && !value.includes('runtime-config'));
  if (!scripts.length) throw new Error('静态首页没有可校验的脚本入口');
  const styles = [...html.matchAll(/<link\b[^>]*\bhref=["']([^"']+\.css(?:[?#][^"']*)?)["']/gi)]
    .map(match => match[1]).filter(value => !/^(?:[a-z]+:)?\/\//i.test(value));
  for (const source of [...scripts, ...styles]) {
    const pathname = decodeURIComponent(source.split(/[?#]/)[0]);
    if (pathname.startsWith('/') && !pathname.startsWith(basePath)) throw new Error('静态首页脚本路径与站点挂载路径不一致');
    const relative = (pathname.startsWith('/') ? pathname.slice(basePath.length) : pathname).replace(/^\/+/, '');
    const file = path.resolve(root, relative);
    if (!contained(root, file)) throw new Error('静态入口超出产物目录');
    try { await fs.access(file); } catch { throw new Error('静态首页引用的脚本不存在'); }
    const stat = await fs.stat(file);
    if (!stat.isFile() || !stat.size) throw new Error('静态首页引用的脚本为空');
  }
}

/** One shared CDS process serves every site; a site allocates a listener, never a process or running container. */
export class StaticWebService {
  private readonly open = new Map<string, OpenSite>();

  constructor(private readonly deps: StaticWebDependencies) {}

  has(idOrName: string): boolean {
    return this.open.has(idOrName) || [...this.open.values()].some(site => site.runtime.serviceName === idOrName);
  }

  names(): string[] { return [...this.open.values()].map(site => site.runtime.serviceName); }

  inspect(idOrName: string): OpenSite | undefined {
    return this.open.get(idOrName) || [...this.open.values()].find(site => site.runtime.serviceName === idOrName);
  }

  async prepare(options: {
    identity: StaticWebIdentity;
    serviceName: string;
    image: string;
    revision: string;
    config: StaticWebConfig;
    env: Record<string, string>;
    check: () => void;
  }): Promise<StaticWebRuntime> {
    const { identity, config, check } = options;
    if (!/^[a-f0-9]{40}$/i.test(options.revision) || !/^(?:sha256:[a-f0-9]{64}|[^\s]+@sha256:[a-f0-9]{64})$/i.test(options.image)) {
      throw new Error('静态部署需要已核验的不可变 CI 产物');
    }
    if (!config.imagePath.startsWith('/') || config.imagePath.includes('..') || config.imagePath.includes('\0')) throw new Error('静态产物目录无效');
    const basePath = (config.basePath || '/').replace(/\/?$/, '/');
    if (!URL_PREFIX.test(basePath) || basePath.includes('..')) throw new Error('静态站路径无效');
    for (const rule of config.proxyRules || []) {
      if (!URL_PREFIX.test(rule.pathPrefix) || rule.pathPrefix.includes('..') || !/^[\w.-]+$/.test(rule.profileId)) throw new Error('静态站接口路由无效');
    }
    const owner = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const id = `static:${randomUUID()}`;
    await fs.mkdir(this.deps.rootDirectory, { recursive: true, mode: 0o755 });
    const ownerDirectory = path.join(await fs.realpath(this.deps.rootDirectory), owner);
    await fs.mkdir(ownerDirectory, { recursive: true, mode: 0o755 });
    if ((await fs.lstat(ownerDirectory)).isSymbolicLink()) throw new Error('静态产物归属目录不安全');
    const rootDirectory = path.join(ownerDirectory, id.slice(7));
    await fs.mkdir(rootDirectory, { mode: 0o755 });
    try {
      check();
      await this.deps.exportFiles(options.image, config.imagePath, rootDirectory, check, identity);
      check();
      await validateFiles(rootDirectory, basePath);
      let publicConfig: Record<string, string | null> | undefined;
      if (config.runtimeConfig) {
        const defaults: unknown = JSON.parse(await fs.readFile(path.join(rootDirectory, 'runtime-config.json'), 'utf8'));
        if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) throw new Error('静态站运行配置格式无效');
        publicConfig = {};
        for (const [key, value] of Object.entries(defaults)) {
          if (!PUBLIC_KEY.test(key) || value !== null && typeof value !== 'string') throw new Error('静态站运行配置包含非公开字段');
          publicConfig[key] = options.env[key] ?? value;
        }
        const script = `globalThis.__IMP_CONFIG__=${JSON.stringify(publicConfig)};\n`;
        await fs.writeFile(path.join(rootDirectory, 'runtime-config.js'), script, { mode: 0o644 });
        await fs.writeFile(path.join(rootDirectory, 'runtime-config'), script, { mode: 0o644 });
        const htmlPath = path.join(rootDirectory, 'index.html');
        const html = await fs.readFile(htmlPath, 'utf8');
        await fs.writeFile(htmlPath, html.replace(/runtime-config\.js(["'])/g, 'runtime-config$1'), { mode: 0o644 });
      }
      const runtime: StaticWebRuntime = { id, serviceName: options.serviceName, ...identity,
        image: options.image, revision: options.revision, rootDirectory,
        basePath, proxyRules: config.proxyRules, runtimeConfig: config.runtimeConfig, browserOnly: config.browserOnly };
      check();
      await fs.writeFile(path.join(rootDirectory, '.cds-static-owner.json'), JSON.stringify(runtime), { mode: 0o600, flag: 'wx' });
      return runtime;
    } catch (error) {
      await fs.rm(rootDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  private async validateOwner(runtime: StaticWebRuntime, allowMissing = false): Promise<boolean> {
    const expectedOwner = createHash('sha256').update(JSON.stringify({ projectId: runtime.projectId, branchId: runtime.branchId, profileId: runtime.profileId })).digest('hex');
    const ownerDirectory = path.join(await fs.realpath(this.deps.rootDirectory), expectedOwner);
    const expectedRoot = path.join(ownerDirectory, runtime.id.slice(7));
    if (!/^static:[a-f0-9-]{36}$/i.test(runtime.id) || runtime.rootDirectory !== expectedRoot) throw new Error('静态运行归属不匹配');
    try {
      if ((await fs.lstat(ownerDirectory)).isSymbolicLink()) throw new Error('静态产物归属目录不安全');
      if ((await fs.lstat(expectedRoot)).isSymbolicLink()) throw new Error('静态产物目录不安全');
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    const manifest = JSON.parse(await fs.readFile(path.join(expectedRoot, '.cds-static-owner.json'), 'utf8'));
    if (JSON.stringify(manifest) !== JSON.stringify(runtime)) throw new Error('静态产物身份不一致');
    return true;
  }

  async discard(runtime: StaticWebRuntime): Promise<void> {
    if (this.has(runtime.id)) throw new Error('静态站点仍在运行，拒绝删除产物');
    if (!await this.validateOwner(runtime, true)) return;
    await fs.rm(runtime.rootDirectory, { recursive: true, force: true });
  }

  async start(runtime: StaticWebRuntime, port: number): Promise<number> {
    await this.validateOwner(runtime);
    const expectedRoot = runtime.rootDirectory;
    await validateFiles(expectedRoot, runtime.basePath);
    const existing = this.open.get(runtime.id);
    if (existing) {
      if (port !== existing.port) throw new Error('静态运行端口不一致');
      return existing.port;
    }
    const app = express();
    app.disable('x-powered-by');
    app.use((req, res, next) => {
      let pathname: string;
      try { pathname = decodeURIComponent(req.path); } catch { res.sendStatus(400); return; }
      if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.'))) { res.sendStatus(404); return; }
      const rule = [...(runtime.proxyRules || [])].sort((a, b) => b.pathPrefix.length - a.pathPrefix.length).find(rule => pathname === rule.pathPrefix || pathname.startsWith(`${rule.pathPrefix.replace(/\/$/, '')}/`));
      if (rule) {
        const upstream = this.deps.resolveUpstream(runtime, rule.profileId);
        if (!upstream) { res.status(503).send('接口服务暂不可用，请稍后重试'); return; }
        const proxy = http.request({ hostname: upstream.host, port: upstream.port, path: req.originalUrl,
          method: req.method, headers: { ...req.headers, host: req.headers.host || `${upstream.host}:${upstream.port}` } }, reply => {
          res.writeHead(reply.statusCode || 502, reply.headers); reply.pipe(res);
        });
        proxy.on('error', () => { if (!res.headersSent) res.status(502).send('接口连接暂不可用，请稍后重试'); else res.destroy(); });
        proxy.setTimeout(120_000, () => proxy.destroy(new Error('upstream timeout')));
        res.once('close', () => proxy.destroy());
        req.pipe(proxy);
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) { res.sendStatus(405); return; }
      next();
    });
    const site = express.Router();
    site.use((req, res, next) => {
      if (/^\/(?:runtime-config(?:\.(?:js|json))?|version\.json)$/.test(req.path)) res.setHeader('Cache-Control', 'no-store');
      next();
    });
    site.use(express.static(expectedRoot, { dotfiles: 'deny', index: false, setHeaders: (res, filename) => {
      if (!path.basename(filename).startsWith('runtime-config') && path.basename(filename) !== 'version.json') res.setHeader('Cache-Control', /[-.][a-z0-9_-]{8,}\.[a-z0-9]+$/i.test(filename) && MIME_ASSET.test(filename) ? 'public, max-age=31536000, immutable' : 'no-cache');
      if (path.basename(filename) === 'runtime-config') res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    } }));
    site.use((req, res) => {
      if (MIME_ASSET.test(req.path) || req.path.startsWith('/assets/')) { res.sendStatus(404); return; }
      res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(expectedRoot, 'index.html'));
    });
    app.use(runtime.basePath, site);
    app.use((_req, res) => res.sendStatus(404));
    const server = http.createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const actual = (server.address() as import('node:net').AddressInfo).port;
    this.open.set(runtime.id, { identity: runtime, runtime, port: actual, server });
    return actual;
  }

  async stop(idOrName: string): Promise<void> {
    const site = this.inspect(idOrName);
    if (!site) return;
    await new Promise<void>((resolve, reject) => {
      const drain = setTimeout(() => site.server.closeAllConnections(), 1_000);
      drain.unref();
      site.server.close(error => { clearTimeout(drain); error ? reject(error) : resolve(); });
      site.server.closeIdleConnections();
    });
    this.open.delete(site.runtime.id);
  }

  async close(): Promise<void> {
    await Promise.all([...this.open.keys()].map(id => this.stop(id)));
  }
}
