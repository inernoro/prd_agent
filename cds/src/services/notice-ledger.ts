/**
 * notice-ledger — CDS 服务端站内信账本。
 *
 * 补的是哪一段：cds-events-bus 的 CDS_EVENT_ALERT_CLASS 早就把「哪些事件够格叫醒人」
 * 收敛好了，注释里也写明「将来的分发器只需 subscribe + isAlertCdsEvent」——但至今
 * **没有任何生产代码调用过 isAlertCdsEvent**（只有测试引用）。铃装好了，线没接。
 * 前端 SiteNoticeInbox 那份是 localStorage + window CustomEvent 的浏览器本地实现，
 * 服务端从没记过一条，所以发布失败在没人开着页面时就是彻底沉默。本服务就是那段线。
 *
 * 三条纪律（与 uptime-monitor 同源）：
 *
 * 1. **不认识任何事件名**。事件 → 中文文案 / 是否入账的映射全部在 cds-events-bus.ts
 *    （`cdsEventNoticeCopy` / `shouldLedgerEvent`）。本文件只按 envelope.data 的
 *    结构化字段渲染。这不只是洁癖：tests/services/release-event-source-guard.test.ts
 *    会扫源码，本文件一旦出现 'release.failed' 之类字面量直接判红——因为那正是
 *    「又长出一张自己的告警清单」的形状。
 *
 * 2. **不无限增长、不进 state.json**。落盘走独立文件 `.cds/notice-ledger.json`，
 *    上限 200 条超出淘汰最老，原子写（tmp + rename），读写失败只 warn 不抛。
 *    与 `.cds/uptime-monitor.json` 完全同款。
 *
 * 3. **外发是旁路，绝不拖累记账**。先把账记进本地并落盘，再去外发；外发挂了只把
 *    失败原因写进 notice.outbound，本地那条通知照样在。反过来（先外发再记账）在
 *    MAP 不可达时会让 CDS 本地也丢通知——那正是「告警缺失最难被发现」的最坏形态。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  cdsEventNoticeCopy,
  cdsEventsBus,
  shouldLedgerEvent,
  type CdsEventEnvelope,
  type CdsEventType,
} from './cds-events-bus.js';
import {
  forwardNoticeToMap,
  type NoticeOutboundConfig,
  type FetchLike,
} from './notice-outbound-map.js';

export type CdsNoticeLevel = 'info' | 'warning' | 'danger';

/** 外发结果。skipped = 没配凭据（如实说「未外发」，绝不假装成功）。 */
export interface CdsNoticeOutbound {
  status: 'sent' | 'skipped' | 'failed';
  at: string;
  reason?: string;
  reference?: string;
}

/**
 * 处理状态机：待处理 → 处理中 → 已解决（可回退到待处理）。
 *
 * 为什么主干是状态而不是「认领人」：CDS 的多用户只在 `CDS_AUTH_MODE=github`
 * 与 ticket SSO 会话里成立，而 `exec_cds.sh init` 产出的标准部署是 basic 模式
 * ——全实例一把共享口令，请求上根本没有 `req.cdsUser`。若把「谁认领的」当主干，
 * 在开发机（github 模式，有真名字）测起来一切正常，一上默认部署就变成「每条
 * 通知都被同一个身份认领」：界面看起来有责任人，实际一个责任人都没有，且不报错。
 * 那是 predicate-and-wiring-discipline 形状 8（把不成立的证据当成已做到的证明）。
 *
 * 所以：**状态机在所有部署模式下都成立**，身份是可选快照——取不到就如实留空，
 * 由前端明说「当前部署未启用账号身份」，绝不回填一个桶名冒充责任人。
 */
export type CdsNoticeStatus = 'open' | 'working' | 'resolved';

export const NOTICE_STATUSES: readonly CdsNoticeStatus[] = ['open', 'working', 'resolved'];

/**
 * 状态变更者。三个字段刻意分开，因为它们的可信度完全不同：
 *
 * - `channel` 永远有值，来自 `resolveActorFromRequest`，但它标的是**调用通道**
 *   （`user` / `ai` / `ai:<name>` / `system:<trigger>`），最后一档把所有 cookie
 *   登录的真人合并成字面量 `user`。**它不是人**，不能当责任人展示。
 * - `userId` / `userLabel` / `provider` 只有真实账号会话（github / 本地账号 / SSO）
 *   才有；共享口令与项目级 Key 一律 null。
 */
export interface CdsNoticeActor {
  channel: string;
  userId: string | null;
  userLabel: string | null;
  provider: string | null;
}

/** 一条通知当前的处理进展。缺席 = 从未被处理过 = `open`（见 noticeStatusOf）。 */
export interface CdsNoticeHandling {
  status: CdsNoticeStatus;
  /** ISO：最近一次状态变更时间 */
  updatedAt: string;
  actor: CdsNoticeActor;
}

/**
 * 状态取值的唯一入口。
 *
 * 判据分裂是本仓库反复踩的坑（形状 3）：只要有第二处写 `record.handling?.status`
 * 再各自兜底，两处的「旧记录算什么状态」迟早漂。列表过滤、计数、路由、前端
 * 全部走这一个函数（前端另有一份同名实现，由守卫测试钉住口径一致）。
 */
export function noticeStatusOf(record: Pick<CdsNoticeRecord, 'handling'>): CdsNoticeStatus {
  return normalizeNoticeStatus(record.handling?.status);
}

/** 未知/缺席一律归 open——旧账本没有这个字段，不能因此从列表里消失。 */
export function normalizeNoticeStatus(value: unknown): CdsNoticeStatus {
  return NOTICE_STATUSES.includes(value as CdsNoticeStatus) ? (value as CdsNoticeStatus) : 'open';
}

/**
 * 落盘记录里的 handling 可能来自旧版本、手改的文件或损坏的写入。
 * 归一时对身份字段一律「不认识就置 null」——宁可显示「未记录责任人」，
 * 也不要把一段来路不明的字符串当成人名渲染出去。
 */
function normalizeHandling(value: unknown): CdsNoticeHandling | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<CdsNoticeHandling> & { actor?: Partial<CdsNoticeActor> };
  const actor: Partial<CdsNoticeActor> = raw.actor && typeof raw.actor === 'object' ? raw.actor : {};
  return {
    status: normalizeNoticeStatus(raw.status),
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : new Date(0).toISOString(),
    actor: {
      channel: typeof actor.channel === 'string' && actor.channel ? actor.channel : 'unknown',
      userId: typeof actor.userId === 'string' && actor.userId ? actor.userId : null,
      userLabel: typeof actor.userLabel === 'string' && actor.userLabel ? actor.userLabel : null,
      provider: typeof actor.provider === 'string' && actor.provider ? actor.provider : null,
    },
  };
}

/**
 * 账本条目。字段刻意与前端既有 SiteNoticePayload 同名（id/title/body/href/
 * actionLabel/source/projectId/projectName/projectSlug），迁移时前端只需把
 * tone 改名成 level。
 */
export interface CdsNoticeRecord {
  id: string;
  /** 合并键：同一件事重复发生时靠它归并成一条（带 occurrences），而不是刷屏。 */
  dedupeKey: string;
  level: CdsNoticeLevel;
  title: string;
  body: string;
  /** release | uptime | drift | self-update | system | env | schema | ops */
  source: string;
  eventType?: CdsEventType;
  projectId?: string;
  projectName?: string;
  projectSlug?: string;
  href?: string;
  actionLabel?: string;
  /** ISO：首次发生 */
  createdAt: string;
  /** ISO：最近一次合并 */
  updatedAt: string;
  occurrences: number;
  readAt?: string;
  dismissedAt?: string;
  outbound?: CdsNoticeOutbound;
  /**
   * 处理进展。缺席 = 待处理（`open`），旧账本免迁移。
   * 读它一律走 `noticeStatusOf`，不要在别处再写一份 `?? 'open'`。
   */
  handling?: CdsNoticeHandling;
}

/** 写入一条通知所需的最小信息（渲染层产出，账本只管归并与落盘）。 */
export interface NoticeInput {
  id: string;
  dedupeKey?: string;
  level: CdsNoticeLevel;
  title: string;
  body: string;
  source: string;
  eventType?: CdsEventType;
  projectId?: string;
  projectName?: string;
  projectSlug?: string;
  href?: string;
  actionLabel?: string;
}

/**
 * 站内信的 href 白名单：只收**同源相对路径**。
 *
 * 为什么必须在账本这一层挡（而不是只在路由层校验）：
 * 通知能由项目级 Agent Key 通过 POST /api/notices 写入，而 SiteNoticeInbox 会把
 * href 直接渲染成 `<a href={notice.href}>`。一个 `javascript:...` 就变成存储型脚本执行——
 * **全局运维**打开自己的 CDS 会话点那条项目通知时执行，等于低权限凭据拿到高权限会话。
 * 账本是所有写入路径的必经之地（内部事件渲染也走这里），挡在这儿才没有绕过口。
 *
 * 判据刻意收得很窄：必须以单个 `/` 开头。放过的话：
 *   - `//evil.com/x` 是协议相对 URL，浏览器当外站，等于开放重定向；
 *   - `javascript:` / `data:` / `vbscript:` 直接执行；
 *   - `https://...` 即使是善意的外链，也不该由通知这条低门槛写入口决定跳到站外。
 * 内部产出的 href 全是 `/release-center?...` 这种形态，不受影响。
 */
/**
 * HTTP 写入口（POST /api/notices）的合并键。
 *
 * 不能直接用调用方给的 `id`：账本按 dedupeKey 全局查找，而项目级 Agent Key 能自由
 * 指定 id。填一个别的项目的 id、或猜中内部事件的键（形如 `release.failed:<targetId>`），
 * upsert 就会把那条记录的标题、正文、projectId 一起改写——原告警等于被从它自己的
 * 作用域里抹掉（Codex review P1，2026-07-29）。
 *
 * 两段前缀各挡一类越界：`api:` 把外部写入与内部事件分到互不相交的键空间；
 * 作用域段把项目之间隔开。同一调用方重复上报同一个 id 仍然正常合并。
 */
export function apiNoticeDedupeKey(scope: string | null | undefined, id: string): string {
  return `api:${scope || '_global'}:${id}`;
}

export function sanitizeNoticeHref(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  // 控制字符可以把 `java\nscript:` 拼回可执行 URL，浏览器解析时会忽略它们。
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
  if (!value.startsWith('/')) return undefined;
  if (value.startsWith('//')) return undefined;
  return value;
}

/** 同一件事在这个窗口内重复发生只累加次数，不重新外发。 */
export const NOTICE_MERGE_WINDOW_MS = 10 * 60_000;

/** 信息中心首屏只承载摘要；完整失败证据留在通知深链指向的发布记录。 */
export const NOTICE_BODY_MAX_CHARS = 240;

export function compactNoticeText(value: string, maxChars: number = NOTICE_BODY_MAX_CHARS): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/** 账本上限：与 uptime 的环形缓冲同理，内存/磁盘都必须有上界。 */
const DEFAULT_MAX_NOTICES = 200;

interface NoticeStoreFile {
  version: 1;
  savedAt: number;
  notices: CdsNoticeRecord[];
}

export type MergeAction = 'created' | 'merged' | 'relit';

/**
 * 归并判定 —— 纯函数，因为「什么时候该响、什么时候不该响」必须能被断言，
 * 而不是埋在订阅回调里靠跑一遍看日志。
 *
 * 这是本仓库第三处手写去重台账：release-events.ts 的 lastLifecycle（终态去重）、
 * release-remote-watcher.ts 的 lastAlerted（签名边沿去重）是前两处，CDS 至今
 * 没有可复用的公共节流工具。三者口径不同（终态 / 签名 / 时间窗），暂不强行抽象，
 * 但新增第四处前应先考虑合并。
 *
 * 三条口径：
 *  - 窗口内重复 → merged：occurrences+1、刷新 updatedAt、**保留 readAt 与 handling**
 *    （已读的东西不该因为又抖了一次就重新标未读；正在处理的事又抖一次，处理进展
 *    更不该被抹掉——那会让「已认领」在对方眼里凭空消失），且**不重新外发**；
 *  - 超窗 → relit：这是「隔了很久又坏了」，属于新事实，清 readAt/dismissedAt/handling、
 *    occurrences 重置为 1、重新外发。**handling 必须一起清**：不清的话，上个月被标成
 *    「已解决」的通知这次重新坏了，界面照样显示「已解决」，等于把新故障伪装成旧结论；
 *  - 窗口内且已被「不再提醒」→ 仍算 merged，但不复活。与前端旧口径
 *    （`if (existing?.dismissedAt) return current`）一致：用户刚说过别烦我。
 */
export function mergeNotice(
  existing: CdsNoticeRecord | undefined,
  incoming: NoticeInput,
  nowMs: number,
  windowMs: number = NOTICE_MERGE_WINDOW_MS,
): { action: MergeAction; record: CdsNoticeRecord } {
  const nowIso = new Date(nowMs).toISOString();
  const dedupeKey = incoming.dedupeKey || incoming.id;
  const base: CdsNoticeRecord = {
    id: incoming.id,
    dedupeKey,
    level: incoming.level,
    title: incoming.title,
    body: incoming.body,
    source: incoming.source,
    ...(incoming.eventType ? { eventType: incoming.eventType } : {}),
    ...(incoming.projectId ? { projectId: incoming.projectId } : {}),
    ...(incoming.projectName ? { projectName: incoming.projectName } : {}),
    ...(incoming.projectSlug ? { projectSlug: incoming.projectSlug } : {}),
    // href 一律过白名单：见 sanitizeNoticeHref。这里是所有写入路径的收口。
    ...((() => { const href = sanitizeNoticeHref(incoming.href); return href ? { href } : {}; })()),
    ...(incoming.actionLabel ? { actionLabel: incoming.actionLabel } : {}),
    createdAt: nowIso,
    updatedAt: nowIso,
    occurrences: 1,
  };

  if (!existing) return { action: 'created', record: base };

  const lastMs = Date.parse(existing.updatedAt);
  const withinWindow = Number.isFinite(lastMs) && nowMs - lastMs < windowMs;

  if (withinWindow) {
    return {
      action: 'merged',
      record: {
        ...base,
        id: existing.id,
        createdAt: existing.createdAt,
        occurrences: existing.occurrences + 1,
        ...(existing.readAt ? { readAt: existing.readAt } : {}),
        ...(existing.dismissedAt ? { dismissedAt: existing.dismissedAt } : {}),
        ...(existing.outbound ? { outbound: existing.outbound } : {}),
        ...(existing.handling ? { handling: existing.handling } : {}),
      },
    };
  }

  // 超窗重燃：readAt / dismissedAt / handling 一并清掉，让它重新变成一条要看的新事。
  // base 本身不带这三个字段，所以「清掉」= 不从 existing 复制过来。
  return { action: 'relit', record: { ...base, id: existing.id, createdAt: existing.createdAt } };
}

export interface NoticeLedgerDeps {
  /** 落盘路径；空串表示只在内存里跑（测试用，与 uptime 的 storePath 同约定）。 */
  storePath: string;
  maxNotices?: number;
  now?: () => number;
  logger?: { warn?: (m: string) => void };
  /**
   * 判项目是否仍存在。删项目后旧通知的 href 会落到 /settings/<旧 id> → 404，
   * 前端曾在 2026-07-21 为此加过「打开面板逐个探活」的清理逻辑；账本搬到服务端后
   * 那段必须跟着搬，否则死链通知原样回归。
   */
  projectExists?: (projectId: string) => boolean;
}

export class NoticeLedgerService {
  private notices: CdsNoticeRecord[] = [];

  constructor(private readonly deps: NoticeLedgerDeps) {
    this.load();
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private get maxNotices(): number {
    return this.deps.maxNotices ?? DEFAULT_MAX_NOTICES;
  }

  /** 未被「不再提醒」的通知，按最近更新倒序。 */
  list(options: { limit?: number; projectId?: string | null; status?: CdsNoticeStatus } = {}): CdsNoticeRecord[] {
    const scope = options.projectId ?? null;
    const rows = this.notices
      .filter((item) => !item.dismissedAt)
      // 项目级凭据只能看自己项目：系统级条目（无 projectId）也不给，否则一把项目
      // Key 就能读到别的项目名与故障原因。口径同 routes/uptime.ts 的 projectScopeOf。
      .filter((item) => (scope ? item.projectId === scope : true))
      // 状态过滤走 noticeStatusOf：旧记录没有 handling，必须被算作 open 才筛得出来，
      // 否则「还有几条没人处理」会漏掉全部存量告警——最该被看见的恰恰是它们。
      .filter((item) => (options.status ? noticeStatusOf(item) === options.status : true))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return typeof options.limit === 'number' ? rows.slice(0, options.limit) : rows;
  }

  /**
   * 本作用域的全量摘要：各状态条数 + 未读条数。
   *
   * 必须**不受列表的 status 过滤影响**——筛选条上的数字和铃铛角标要是随着当前选中项
   * 跳变，用户就没法回答「还有几条没人处理」了。所以这里始终按整个作用域算一遍。
   * 未读与状态是两条独立的轴（看过一眼 ≠ 有人接手），故分开返回、不互相推导。
   */
  summary(projectId?: string | null): { counts: Record<CdsNoticeStatus, number>; unread: number } {
    const counts: Record<CdsNoticeStatus, number> = { open: 0, working: 0, resolved: 0 };
    let unread = 0;
    for (const item of this.list({ projectId })) {
      counts[noticeStatusOf(item)] += 1;
      if (!item.readAt) unread += 1;
    }
    return { counts, unread };
  }

  /**
   * 推进处理状态机（认领 / 退回 / 标记已解决共用一条路径）。
   *
   * 三条设计约束：
   *  1. **查找必须 (id, 作用域) 一次查**，不能「先取第一条同 id 的再校验 projectId」——
   *     record.id 由调用方控制，两个项目完全可能各有一条同 id 的通知，取第一条会让
   *     项目 A 认领自己的通知却命中 B 那条、校验不过返 404（dismiss 为此挨过 Codex P2）。
   *  2. **身份取不到就落 null**，绝不回填 channel 桶名冒充责任人（见 CdsNoticeActor）。
   *  3. 已被「不再提醒」的不给推进——它已经不在任何人的视野里，改它的状态没有意义，
   *     还会让计数与列表对不上（列表过滤 dismissed，计数也过滤）。
   */
  setHandling(
    id: string,
    status: CdsNoticeStatus,
    actor: CdsNoticeActor,
    projectId?: string | null,
  ): CdsNoticeRecord | null {
    const target = projectId
      ? this.notices.find((item) => item.id === id && item.projectId === projectId)
      : this.notices.find((item) => item.id === id);
    if (!target || target.dismissedAt) return null;
    const nowIso = new Date(this.now()).toISOString();
    target.handling = {
      status,
      updatedAt: nowIso,
      actor: {
        channel: actor.channel,
        userId: actor.userId,
        userLabel: actor.userLabel,
        provider: actor.provider,
      },
    };
    // 有人开始处理即视为已读：否则「处理中」的条目还在未读计数里，铃铛数字与实际不符。
    target.readAt = target.readAt || nowIso;
    this.persist();
    return target;
  }

  getByDedupeKey(dedupeKey: string): CdsNoticeRecord | undefined {
    return this.notices.find((item) => item.dedupeKey === dedupeKey);
  }

  /** 归并写入一条通知，返回归并动作与落库后的记录。 */
  upsert(input: NoticeInput): { action: MergeAction; record: CdsNoticeRecord } {
    const dedupeKey = input.dedupeKey || input.id;
    const existing = this.getByDedupeKey(dedupeKey);
    const merged = mergeNotice(existing, { ...input, dedupeKey }, this.now());
    this.notices = [merged.record, ...this.notices.filter((item) => item.dedupeKey !== dedupeKey)]
      .slice(0, this.maxNotices);
    this.persist();
    return merged;
  }

  /** 外发结果回填。外发是旁路，记账已经完成，这里只补一个字段。 */
  patchOutbound(dedupeKey: string, outbound: CdsNoticeOutbound): void {
    const target = this.notices.find((item) => item.dedupeKey === dedupeKey);
    if (!target) return;
    target.outbound = outbound;
    this.persist();
  }

  markAllRead(projectId?: string | null): number {
    const nowIso = new Date(this.now()).toISOString();
    let changed = 0;
    for (const item of this.notices) {
      if (item.dismissedAt || item.readAt) continue;
      if (projectId && item.projectId !== projectId) continue;
      item.readAt = nowIso;
      changed += 1;
    }
    if (changed > 0) this.persist();
    return changed;
  }

  dismiss(id: string, projectId?: string | null): boolean {
    const nowIso = new Date(this.now()).toISOString();
    // 必须把作用域一起纳入查找条件，不能「先取第一条同 id 的、再校验 projectId」：
    // record.id 由调用方控制，两个项目完全可能各有一条同 id 的通知。先取第一条的话，
    // 项目 A 忽略自己的通知会取到 B 那条、校验不过返回 404 —— 它明明有这条通知却关不掉
    // （Codex review P2，2026-07-29）。
    const target = projectId
      ? this.notices.find((item) => item.id === id && item.projectId === projectId)
      : this.notices.find((item) => item.id === id);
    if (!target) return false;
    target.readAt = target.readAt || nowIso;
    target.dismissedAt = nowIso;
    this.persist();
    return true;
  }

  /**
   * 清掉指向已删除项目的通知（死链治理）。
   *
   * 只在 projectExists 明确回答 false 时删——探不到 / 没接这个判定源时一律不动，
   * 与前端旧逻辑「只认 404，网络错误不判死」同口径。惰性调用（GET 时跑一次），
   * 不额外起定时器。
   */
  pruneDeletedProjects(): number {
    const exists = this.deps.projectExists;
    if (!exists) return 0;
    const before = this.notices.length;
    this.notices = this.notices.filter((item) => {
      if (!item.projectId) return true;
      try {
        return exists(item.projectId) !== false;
      } catch {
        return true; // 判定源自己出错不判死
      }
    });
    const removed = before - this.notices.length;
    if (removed > 0) this.persist();
    return removed;
  }

  // ── 持久化：独立文件 + 原子写，失败静默（通知不能拖垮主流程） ──

  private load(): void {
    const fp = this.deps.storePath;
    if (!fp) return;
    try {
      if (!fs.existsSync(fp)) return;
      const parsed = JSON.parse(fs.readFileSync(fp, 'utf8')) as NoticeStoreFile;
      if (!parsed || !Array.isArray(parsed.notices)) return;
      this.notices = parsed.notices
        .filter((item) => item && typeof item.id === 'string' && typeof item.title === 'string')
        .map((item) => ({
          ...item,
          dedupeKey: typeof item.dedupeKey === 'string' && item.dedupeKey ? item.dedupeKey : item.id,
          occurrences: Number.isFinite(item.occurrences) ? item.occurrences : 1,
          createdAt: item.createdAt || new Date(this.now()).toISOString(),
          updatedAt: item.updatedAt || item.createdAt || new Date(this.now()).toISOString(),
          // 旧账本没有 handling：保持 undefined 由 noticeStatusOf 判 open，不凭空造一条
          // 「有人处理过」的记录。有 handling 的走归一，损坏字段一律降级而不是原样渲染。
          ...(item.handling ? { handling: normalizeHandling(item.handling) } : {}),
        }))
        .slice(0, this.maxNotices);
    } catch (err) {
      this.deps.logger?.warn?.(`[notice] 读取历史失败，从空账本开始: ${(err as Error).message}`);
    }
  }

  private persist(): void {
    const fp = this.deps.storePath;
    if (!fp) return;
    const payload: NoticeStoreFile = {
      version: 1,
      savedAt: this.now(),
      notices: this.notices.slice(0, this.maxNotices),
    };
    try {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      const tmp = `${fp}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, fp);
    } catch (err) {
      this.deps.logger?.warn?.(`[notice] 落盘失败（仅内存保留）: ${(err as Error).message}`);
    }
  }
}

/**
 * envelope → 站内信输入。
 *
 * **只读结构化字段，不认任何事件名**（见文件头纪律 1）。文案与深链类别由
 * cdsEventNoticeCopy 给，本函数负责把 data 里的 id / 名字 / 错误原文填进去。
 */
export function renderNoticeFromEvent(envelope: CdsEventEnvelope): NoticeInput | null {
  const copy = cdsEventNoticeCopy(envelope.type);
  if (!copy) return null;
  const data = (envelope.data ?? {}) as {
    projectId?: string;
    projectName?: string;
    projectSlug?: string;
    targetId?: string;
    targetName?: string;
    releaseId?: string;
    branchId?: string;
    commitSha?: string;
    message?: string;
    errorMessage?: string;
    failure?: { summary?: string; reason?: string };
  };

  // 同一目标的同一类事件归成一条。targetId 优先（发布/存活都以目标为单位），
  // 没有目标的系统级事件（infra 熔断 / 自更新）退到项目或全局。
  const scopeKey = data.targetId || data.branchId || data.projectId || 'system';
  const dedupeKey = `${envelope.type}:${scopeKey}`;

  // 结构化摘要优先于原始 stderr。原始发布日志可能有数百行，只能去发布记录展开。
  const detail = [data.message, data.failure?.summary, data.failure?.reason, data.errorMessage]
    .find((text) => typeof text === 'string' && text.trim().length > 0);
  const subject = data.targetName || data.projectName || data.projectSlug || data.branchId || '';
  const body = compactNoticeText([subject, detail].filter(Boolean).join(' — ') || copy.title);

  let href: string | undefined;
  if (copy.link === 'release') {
    const params = new URLSearchParams();
    if (data.projectId) params.set('project', data.projectId);
    if (data.targetId) params.set('target', data.targetId);
    if (data.releaseId) params.set('run', data.releaseId);
    // 待人工确认的通知靠这两个参数钉住「批的是哪一版」。少了它们，人点进来
    // 发布中心会重新解析当前最新版本，跟通知里刚过检的那一版不是一回事。
    if (data.branchId) params.set('branch', data.branchId);
    if (data.commitSha) params.set('commit', data.commitSha);
    const query = params.toString();
    href = query ? `/release-center?${query}` : '/release-center';
  } else if (copy.link === 'status') {
    href = '/status';
  } else if (copy.link === 'maintenance') {
    href = '/cds-settings';
  }

  return {
    id: `ntc_${dedupeKey.replace(/[^a-zA-Z0-9_.-]/g, '_')}`,
    dedupeKey,
    level: copy.level,
    title: copy.title,
    body,
    source: copy.source,
    eventType: envelope.type,
    ...(data.projectId ? { projectId: data.projectId } : {}),
    ...(data.projectName ? { projectName: data.projectName } : {}),
    ...(data.projectSlug ? { projectSlug: data.projectSlug } : {}),
    ...(href ? { href } : {}),
    ...(copy.actionLabel ? { actionLabel: copy.actionLabel } : {}),
  };
}

export interface StartNoticeLedgerDeps {
  ledger: NoticeLedgerService;
  /** 外发配置；null = 未配置凭据，此时必须如实记 skipped，绝不假装发送成功。 */
  outbound: NoticeOutboundConfig | null;
  /** 记完账后回发总线，前端据此实时亮铃。传 cdsEventsBus.publish 即可。 */
  publish?: (type: CdsEventType, data: unknown) => void;
  fetchImpl?: FetchLike;
  logger?: { warn?: (m: string) => void };
}

/**
 * 唯一订阅点：把总线上够格叫醒人的事件记进账本，再（可选）外发。
 *
 * 这一行接线**删掉不会红，只会静默退化**——账本类还在、单测照常全绿，只是永远
 * 没有任何东西写进去。故有源码守卫 tests/services/notice-ledger-wiring-guard.test.ts。
 */
export function startNoticeLedger(deps: StartNoticeLedgerDeps): { stop(): void } {
  const unsubscribe = cdsEventsBus.subscribe((envelope) => {
    if (!shouldLedgerEvent(envelope.type, envelope.data)) return;
    const input = renderNoticeFromEvent(envelope);
    if (!input) return;

    // 先记账再外发：MAP 不可达时本地这条必须还在（见文件头纪律 3）。
    const { action, record } = deps.ledger.upsert(input);
    deps.publish?.('notice.created', record);

    // 窗口内的重复只累加次数，不再打扰外部系统一次。
    if (action === 'merged') return;

    if (!deps.outbound) {
      deps.ledger.patchOutbound(record.dedupeKey, {
        status: 'skipped',
        at: new Date().toISOString(),
        reason: '未配置 MAP 通知外发凭据（CDS_NOTICE_MAP_BASE_URL / CDS_NOTICE_MAP_TOKEN）',
      });
      return;
    }

    void forwardNoticeToMap(record, deps.outbound, deps.fetchImpl)
      .then((result) => {
        deps.ledger.patchOutbound(record.dedupeKey, {
          status: result.ok ? 'sent' : 'failed',
          at: new Date().toISOString(),
          ...(result.reference ? { reference: result.reference } : {}),
          ...(result.reason ? { reason: result.reason } : {}),
        });
      })
      .catch((err: unknown) => {
        // forwardNoticeToMap 内部已兜住异常；这里是最后一道，绝不让外发把进程带走。
        deps.ledger.patchOutbound(record.dedupeKey, {
          status: 'failed',
          at: new Date().toISOString(),
          reason: `外发异常：${err instanceof Error ? err.message : String(err)}`,
        });
        deps.logger?.warn?.(`[notice] 外发异常: ${err instanceof Error ? err.message : String(err)}`);
      });
  });
  return { stop: unsubscribe };
}
