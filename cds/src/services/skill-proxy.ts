/**
 * 技能代理：CDS 作为「中介」把 MAP 的匿名官方技能转发给客户项目。
 *
 * 为什么 CDS 要代理，而不是让脚本直接 curl MAP：
 * - 客户接不进 MAP（那是我们的内部平台），但所有人都要上 CDS 拿云端预览，
 *   所以对方应该只需要记住 CDS 一个域名。
 * - 技能内容的单一事实源仍留在 MAP，CDS 不存第二份 —— 避免 findmapskills
 *   那种「两处维护、注释里写着两边都要改」的漂移。
 * - 自托管 CDS 没有本地 `.claude/skills`，走代理才拿得到方法论套装。
 *
 * 缓存语义（客户现场装环境时网络最不可控，这条兜底是必须的）：
 *   命中且新鲜        → 直接返回
 *   命中但过期        → 回源；回源成功刷新缓存，回源失败返回陈旧副本并标记
 *   未命中且回源失败  → 明确报错，不静默降级、不装半包
 *
 * 详见 doc/design.cds.project-bootstrap.md。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 缓存新鲜期：技能内容随 MAP 部署更新，10 分钟足够压住突发流量又不至于发太旧的版本。 */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** 单个技能包体积上限，防止上游异常时把磁盘写爆。 */
const MAX_SKILL_BYTES = 64 * 1024 * 1024;

export interface SkillProxyOptions {
  /** MAP 基址，来自 CDS 配置；自托管客户可指向自己的 MAP 实例。 */
  mapBase: string;
  /** 缓存目录，通常是 `<repoRoot>/.cds/skill-cache`。 */
  cacheDir: string;
  /** 注入 fetch 便于测试；默认用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 注入时钟便于测试缓存过期。 */
  now?: () => number;
}

export interface SkillFetchResult {
  body: Buffer;
  contentType: string;
  /** true 表示回源失败、返回的是过期缓存副本 —— 调用方必须如实告知用户。 */
  stale: boolean;
  /** 内容来源，用于响应头与日志。 */
  source: 'upstream' | 'cache';
}

export class SkillProxyError extends Error {
  constructor(message: string, readonly status: number, readonly hint: string) {
    super(message);
    this.name = 'SkillProxyError';
  }
}

/** 技能 key 只允许 kebab-case，挡住 `../` 这类路径穿越。 */
export function isSafeSkillKey(key: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(key);
}

export class SkillProxy {
  private readonly mapBase: string;
  private readonly cacheDir: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(opts: SkillProxyOptions) {
    this.mapBase = opts.mapBase.replace(/\/+$/, '');
    this.cacheDir = opts.cacheDir;
    this.fetchImpl = opts.fetchImpl || ((...args) => fetch(...args));
    this.now = opts.now || (() => Date.now());
  }

  /** 上游 MAP 的技能下载地址（供脚本注释与排障展示，不含任何凭据）。 */
  upstreamUrlFor(key: string): string {
    return `${this.mapBase}/api/official-skills/${encodeURIComponent(key)}/download`;
  }

  /**
   * 取技能包 zip。缓存优先，回源兜底，两头都没有才报错。
   */
  async fetchSkill(key: string): Promise<SkillFetchResult> {
    if (!isSafeSkillKey(key)) {
      throw new SkillProxyError(`技能名不合法: ${key}`, 400, '技能名只能是小写字母、数字和连字符。');
    }
    const cachePath = path.join(this.cacheDir, `${key}.zip`);
    const cached = this.readCache(cachePath);

    // 负数龄期意味着文件时间在未来（时钟偏斜、跨机器拷贝缓存目录）。
    // 不加这条守卫的话，这种缓存会被永远判为「新鲜」，再也不回源。
    const age = cached ? this.now() - cached.mtimeMs : Number.POSITIVE_INFINITY;
    if (cached && age >= 0 && age < CACHE_TTL_MS) {
      return { body: cached.body, contentType: 'application/zip', stale: false, source: 'cache' };
    }

    try {
      const body = await this.download(this.upstreamUrlFor(key));
      await this.writeCache(cachePath, body);
      return { body, contentType: 'application/zip', stale: false, source: 'upstream' };
    } catch (err) {
      if (cached) {
        // 回源失败但有旧副本：装得上比装不上重要，但必须让用户知道用的是缓存版本
        // eslint-disable-next-line no-console
        console.warn('[skill-proxy] 回源失败，返回陈旧缓存', { key, error: String(err) });
        return { body: cached.body, contentType: 'application/zip', stale: true, source: 'cache' };
      }
      throw new SkillProxyError(
        `无法从 ${this.mapBase} 获取技能 ${key}`,
        502,
        '技能来源当前不可达，且本地没有可用缓存。这不是你的项目有问题——请检查网络后重试。',
      );
    }
  }

  /** 取角色套装清单（JSON 直接透传，不落缓存 —— 体积小且需要实时）。 */
  async fetchBundles(): Promise<unknown> {
    const url = `${this.mapBase}/api/official-skills/bundles`;
    try {
      const res = await this.fetchImpl(url, { method: 'GET' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      throw new SkillProxyError(
        `无法从 ${this.mapBase} 获取套装清单`,
        502,
        '技能来源当前不可达。预设仍可安装（走缓存），但清单暂时显示不出来。',
      );
    }
  }

  private async download(url: string): Promise<Buffer> {
    const res = await this.fetchImpl(url, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0) throw new Error('上游返回空内容');
    if (buf.byteLength > MAX_SKILL_BYTES) throw new Error(`技能包超过上限 ${MAX_SKILL_BYTES} 字节`);
    return buf;
  }

  private readCache(cachePath: string): { body: Buffer; mtimeMs: number } | null {
    try {
      const stat = fs.statSync(cachePath);
      if (!stat.isFile() || stat.size === 0) return null;
      return { body: fs.readFileSync(cachePath), mtimeMs: stat.mtimeMs };
    } catch {
      return null;
    }
  }

  private async writeCache(cachePath: string, body: Buffer): Promise<void> {
    try {
      await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
      // 先写临时文件再 rename：避免并发下载互相读到写了一半的 zip
      const tmp = `${cachePath}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, body);
      await fs.promises.rename(tmp, cachePath);
    } catch (err) {
      // 缓存写失败不影响本次下载，只是下次还得回源
      // eslint-disable-next-line no-console
      console.warn('[skill-proxy] 缓存写入失败', { cachePath, error: String(err) });
    }
  }
}
