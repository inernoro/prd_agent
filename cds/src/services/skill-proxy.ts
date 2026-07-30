/**
 * 技能分发：CDS 先提供随版本发布的启动套件与本地技能，再代理 MAP 官方技能。
 *
 * 为什么 CDS 要代理，而不是让脚本直接 curl MAP：
 * - 客户接不进 MAP（那是我们的内部平台），但所有人都要上 CDS 拿云端预览，
 *   所以对方应该只需要记住 CDS 一个域名。
 * - 启动页使用的技能必须随 CDS 版本确定可用，不能引用 MAP 中不存在的 key。
 * - CDS 仓库已经携带的技能直接按当前版本打包；其他技能仍以 MAP 为事实源。
 * - 自托管 CDS 没有本地 `.claude/skills`，走代理才拿得到方法论套装。
 *
 * 分发语义（客户现场装环境时网络最不可控，这条兜底是必须的）：
 *   CDS 本地携带       → 直接打包返回，不访问 MAP
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

/** 文件系统 mtime 可能比 Date.now() 多出亚毫秒精度；仅把超过 1 秒的未来时间视为时钟偏斜。 */
const CACHE_FUTURE_TOLERANCE_MS = 1_000;

/** 单个技能包体积上限，防止上游异常时把磁盘写爆。 */
const MAX_SKILL_BYTES = 64 * 1024 * 1024;

/** 回源超时：客户在等一条命令跑完，不能无限期挂着连接。 */
const DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * 边读边计数地取回响应体，超限立即中止。
 *
 * 不能先 `await res.arrayBuffer()` 再判大小：那是把整个响应缓冲进堆之后才检查，
 * 上游返回异常大的体时，堆已经吃完了才轮到我们说「超限」。这个函数是
 * skill-proxy 与 bootstrap 两条匿名下载路径共用的唯一实现，别再写第二份。
 */
export async function readCappedBody(res: Response, maxBytes: number): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('上游响应没有可读流');
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`上游响应超过 ${maxBytes} 字节上限`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * 上游返回的字节到底是不是一个 zip。
 *
 * 不校验的后果不是「下载失败」而是「失败被缓存住」：MAP 前面挡了一层网关时，
 * 故障期常见的是 200 + 一张 HTML 错误页，非空、够长、看着像正常响应。那份内容
 * 会被当成技能包写进十分钟缓存，客户侧 unzip 报错，而且**MAP 恢复了也没用**——
 * 得等缓存自己过期。所以要在落盘之前认出它。
 *
 * 只认魔数不解析目录：截断的 zip 同样以 PK\x03\x04 开头，这里挡的是「根本不是 zip」
 * 这一类（HTML/JSON 错误页），完整性由下游 unzip 兜底。
 */
export function looksLikeZip(buf: Buffer): boolean {
  if (buf.byteLength < 4) return false;
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) return false; // "PK"
  // 本地文件头 / 空档案 / 分卷，三种合法起始
  const c = buf[2], d = buf[3];
  return (c === 0x03 && d === 0x04) || (c === 0x05 && d === 0x06) || (c === 0x07 && d === 0x08);
}

export interface SkillProxyOptions {
  /** MAP 基址，来自 CDS 配置；自托管客户可指向自己的 MAP 实例。 */
  mapBase: string;
  /** 缓存目录，通常是 `<repoRoot>/.cds/skill-cache`。 */
  cacheDir: string;
  /** 注入 fetch 便于测试；默认用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 注入时钟便于测试缓存过期。 */
  now?: () => number;
  /** CDS 随版本携带的项目级技能根；命中时本地优先，不向 MAP 请求不存在的 key。 */
  localSkillRoots?: string[];
}

export interface SkillFetchResult {
  body: Buffer;
  contentType: string;
  /** true 表示回源失败、返回的是过期缓存副本 —— 调用方必须如实告知用户。 */
  stale: boolean;
  /** 内容来源，用于响应头与日志。 */
  source: 'upstream' | 'cache' | 'local';
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

/**
 * CDS 启动助手的稳定目录。它不是完整海鲜市场，只声明当前 CDS 版本能够交付的
 * 首次上手技能；更多技能仍由 findmapskills 使用带 Key 的市场搜索接口发现。
 */
export const STARTER_SKILL_BUNDLES = {
  bundles: [
    {
      key: 'starter-core',
      label: '项目上手基础套件',
      summary: '从需求澄清到方案、风险与真实预览的基础工作方法。',
      roles: ['pm', 'owner', 'domain-expert', 'dev', 'qa'],
      skills: [
        {
          key: 'skill-validation',
          name: '需求澄清',
          description: '发现模糊、遗漏和不可验收的需求。',
          roles: ['pm', 'owner', 'domain-expert', 'dev', 'qa'],
        },
        {
          key: 'plan-first',
          name: '先出方案',
          description: '动手前先说明路径、影响和取舍。',
          roles: ['pm', 'owner', 'domain-expert', 'dev'],
        },
        {
          key: 'risk-matrix',
          name: '风险矩阵',
          description: '提前识别业务、体验和上线风险。',
          roles: ['pm', 'owner', 'domain-expert', 'dev', 'qa'],
        },
        {
          key: 'preview-url',
          name: '真实预览地址',
          description: '部署后读取 CDS 返回的真实访问地址。',
          roles: ['pm', 'owner', 'domain-expert', 'dev', 'qa'],
        },
      ],
    },
  ],
} as const;

interface LocalZipEntry {
  name: string;
  body: Buffer;
  mtimeMs: number;
}

/** ZIP 使用的 CRC32；本地技能包采用 store 模式，避免运行镜像额外依赖 zip 命令。 */
function crc32(body: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(mtimeMs: number): { date: number; time: number } {
  const raw = new Date(mtimeMs);
  const year = Math.min(2107, Math.max(1980, raw.getFullYear()));
  const month = raw.getMonth() + 1;
  const day = raw.getDate();
  return {
    date: ((year - 1980) << 9) | (month << 5) | day,
    time: (raw.getHours() << 11) | (raw.getMinutes() << 5) | Math.floor(raw.getSeconds() / 2),
  };
}

/** 生成标准 ZIP，目录名固定为技能 key，解压后可直接落进任一 skills 根。 */
function buildStoredZip(entries: LocalZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const checksum = crc32(entry.body);
    const stamp = dosDateTime(entry.mtimeMs);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.body.byteLength, 18);
    local.writeUInt32LE(entry.body.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.body.byteLength, 20);
    central.writeUInt32LE(entry.body.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, name, entry.body);
    centralParts.push(central, name);
    offset += local.byteLength + name.byteLength + entry.body.byteLength;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

export class SkillProxy {
  private readonly mapBase: string;
  private readonly cacheDir: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly localSkillRoots: string[];
  /**
   * 按 key 的单飞表。冷缓存时并发的匿名下载会各自回源一次 ——
   * 这些路由是匿名的且 CDS 没有全局限流，并发调用方能把连接、内存和上游带宽
   * 一起吃干净。同一个 key 的并发请求共享一次回源。
   */
  private readonly inflight = new Map<string, Promise<Buffer>>();
  private readonly localArchives = new Map<string, { signature: string; body: Buffer }>();
  private readonly localInflight = new Map<string, Promise<Buffer | null>>();

  constructor(opts: SkillProxyOptions) {
    this.mapBase = opts.mapBase.replace(/\/+$/, '');
    this.cacheDir = opts.cacheDir;
    this.fetchImpl = opts.fetchImpl || ((...args) => fetch(...args));
    this.now = opts.now || (() => Date.now());
    this.localSkillRoots = opts.localSkillRoots || [];
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

    const local = await this.localSkill(key);
    if (local) {
      return { body: local, contentType: 'application/zip', stale: false, source: 'local' };
    }

    // 负数龄期意味着文件时间在未来（时钟偏斜、跨机器拷贝缓存目录）。
    // 不加这条守卫的话，这种缓存会被永远判为「新鲜」，再也不回源。
    const age = cached ? this.now() - cached.mtimeMs : Number.POSITIVE_INFINITY;
    if (cached && age >= -CACHE_FUTURE_TOLERANCE_MS && age < CACHE_TTL_MS) {
      return { body: cached.body, contentType: 'application/zip', stale: false, source: 'cache' };
    }

    try {
      const body = await this.downloadOnce(key, cachePath);
      return { body, contentType: 'application/zip', stale: false, source: 'upstream' };
    } catch (err) {
      if (cached) {
        // 回源失败但有旧副本：装得上比装不上重要，但必须让用户知道用的是缓存版本
        // eslint-disable-next-line no-console
        console.warn('[skill-proxy] 回源失败，返回陈旧缓存', { key, error: String(err) });
        return { body: cached.body, contentType: 'application/zip', stale: true, source: 'cache' };
      }
      if (err instanceof SkillProxyError) throw err;
      throw new SkillProxyError(
        `无法从 ${this.mapBase} 获取技能 ${key}`,
        502,
        '技能来源当前不可达，且本地没有可用缓存。这不是你的项目有问题——请检查网络后重试。',
      );
    }
  }

  /**
   * 取角色套装清单。启动目录属于 CDS 发布契约，不依赖需要 Key 的市场搜索接口，
   * 也不请求 MAP 中不存在的 `/official-skills/bundles`。
   */
  async fetchBundles(): Promise<unknown> {
    return STARTER_SKILL_BUNDLES;
  }

  private localSkill(key: string): Promise<Buffer | null> {
    const running = this.localInflight.get(key);
    if (running) return running;
    const task = this.buildLocalSkill(key).finally(() => { this.localInflight.delete(key); });
    this.localInflight.set(key, task);
    return task;
  }

  private async buildLocalSkill(key: string): Promise<Buffer | null> {
    let skillDir: string | null = null;
    for (const root of this.localSkillRoots) {
      const candidate = path.join(root, key);
      const stat = await fs.promises.stat(candidate).catch(() => null);
      if (stat?.isDirectory()) { skillDir = candidate; break; }
    }
    if (!skillDir) return null;

    const entries: LocalZipEntry[] = [];
    const walk = async (dir: string): Promise<void> => {
      const children = await fs.promises.readdir(dir, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        const full = path.join(dir, child.name);
        if (child.isDirectory()) { await walk(full); continue; }
        if (!child.isFile()) continue;
        const stat = await fs.promises.stat(full);
        const body = await fs.promises.readFile(full);
        entries.push({
          name: `${key}/${path.relative(skillDir!, full).split(path.sep).join('/')}`,
          body,
          mtimeMs: stat.mtimeMs,
        });
      }
    };
    await walk(skillDir);
    if (entries.length === 0) return null;
    const total = entries.reduce((sum, entry) => sum + entry.body.byteLength, 0);
    if (total > MAX_SKILL_BYTES) throw new SkillProxyError(
      `本地技能 ${key} 超过体积上限`,
      500,
      'CDS 随版本携带的技能包异常，请联系 CDS 管理员。',
    );
    const signature = entries.map((entry) => `${entry.name}:${entry.body.byteLength}:${Math.round(entry.mtimeMs)}`).join('|');
    const cachedLocal = this.localArchives.get(key);
    if (cachedLocal?.signature === signature) return cachedLocal.body;
    const body = buildStoredZip(entries);
    this.localArchives.set(key, { signature, body });
    return body;
  }

  /** 同一 key 的并发回源合并成一次，成功后落缓存。 */
  private downloadOnce(key: string, cachePath: string): Promise<Buffer> {
    const running = this.inflight.get(key);
    if (running) return running;

    const task = (async () => {
      const body = await this.download(this.upstreamUrlFor(key));
      await this.writeCache(cachePath, body);
      return body;
    })().finally(() => { this.inflight.delete(key); });

    this.inflight.set(key, task);
    return task;
  }

  private async download(url: string): Promise<Buffer> {
    const res = await this.fetchImpl(url, {
      method: 'GET',
      // 没有超时的话，上游卡住就把这条连接（和调用方）无限期挂在这里
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      if (res.status === 404) {
        throw new SkillProxyError(
          '技能不存在',
          404,
          '该技能不在当前 CDS 版本或 MAP 官方技能中，请刷新技能目录后重试。',
        );
      }
      throw new Error(`HTTP ${res.status}`);
    }
    const buf = await readCappedBody(res, MAX_SKILL_BYTES);
    if (buf.byteLength === 0) throw new Error('上游返回空内容');
    // 落盘/入缓存前认一下：200 + HTML 错误页会被缓存十分钟，届时 MAP 恢复也救不回来
    if (!looksLikeZip(buf)) throw new Error('上游返回的不是 zip（可能是错误页）');
    return buf;
  }

  private readCache(cachePath: string): { body: Buffer; mtimeMs: number } | null {
    try {
      const stat = fs.statSync(cachePath);
      if (!stat.isFile() || stat.size === 0) return null;
      const body = fs.readFileSync(cachePath);
      // 旧版本写进来的坏内容（校验是 2026-07-28 才加的）当成未命中，让它自愈回源，
      // 而不是一直把错误页当作「陈旧但可用的副本」发下去
      if (!looksLikeZip(body)) return null;
      return { body, mtimeMs: stat.mtimeMs };
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
