/*
 * 通知通道的读写接口（CDS 系统设置 → 接入 → 通知）。
 *
 * 这一页是整条监控链的最后一公里。它此前卡在一个很具体的地方：唯一的通道是 MAP
 * 站内通知，而接上它要先定两件只有人能定的事（发给哪个 MAP 账号、用哪个 MAP 实例），
 * 于是铃就一直没接。用户 2026-09-15 原话：「支持的协议可以和 map 一样，什么 bark
 * 什么的通知 curl 什么的」——Bark key 是一个人当场就能粘进来的东西，这条路不需要
 * 等任何决定。
 *
 * 三条贯穿全文件的纪律：
 *
 * 1. **秘密只写不读**。Bark key、请求头的值、MAP 私钥，读接口一个都不回。
 *    读接口把密钥吐回去，是最常见的那种「看起来只是个设置页」的泄漏面。
 *    相应地，更新时**留空 = 保持原值**——否则每改一次名字都得把密钥重敲一遍。
 * 2. **Webhook 地址回全量**。它和 MAP 的 endpoint 同级，藏起来就没法编辑。
 *    代价要说在明处：地址里带 token 的（飞书、企业微信那种）会显示在这一页，
 *    要藏就放进请求头——请求头的值只写不读。这句话必须出现在界面上。
 * 3. **项目级 Key 一律 403**。通道是系统级的，一个项目的 key 不该能改到别人的铃。
 */
import type { Request, Response, Router } from 'express';
import crypto from 'node:crypto';

// 项目作用域判定只许有一份：这里直接用 uptime 路由那一个，不复制一条同款单行。
import { assertUnscopedAdmin } from '../services/unscoped-admin-guard.js';

import { ALARM_HISTORY_SOURCE, summarizeAlarmDeliveries } from '../services/alarm-delivery-history.js';
import type { ServerEventLogSink } from '../services/server-event-log-store.js';
import { AlarmLedger, type AlarmChannelStatusView } from '../services/alarm-channel.js';
import { BARK_LEVELS, drillEvent, sendAlarm } from '../services/alarm-dispatch.js';
import {
  ALARM_EVENT_KINDS,
  channelConfigured,
  normalizeEventKind,
  type AlarmChannelConfig,
  type AlarmChannelKind,
  type AlarmEventKind,
  alarmTransportFingerprint,
} from '../services/alarm-route.js';

export interface AlarmChannelRoutesDeps {
  list: () => AlarmChannelConfig[];
  upsert: (channel: AlarmChannelConfig) => void;
  remove: (id: string) => boolean;
  ledger: AlarmLedger;
  history?: ServerEventLogSink | null;
  /** 面板深链，进通知正文。拿不到就不放——编一个点不开的地址比没有更糟。 */
  boardUrl?: () => string | undefined;
}

const KINDS: ReadonlyArray<AlarmChannelKind> = ['bark', 'webhook', 'map'];
const METHODS = ['GET', 'POST', 'PUT'] as const;
/** 请求头数量上限。没有上限的 map 会变成一个可以塞任意大小内容的存储位。 */
const MAX_HEADERS = 10;

function fingerprint(pem: string): string {
  return crypto.createHash('sha256').update(pem).digest('hex').slice(0, 16);
}

/** 脱敏视图。这是唯一允许出网的形状——任何新增字段都要先问「它是不是秘密」。 */
export function publicChannel(c: AlarmChannelConfig): Record<string, unknown> {
  const base = {
    id: c.id, name: c.name, kind: c.kind, enabled: c.enabled,
    projects: c.projects, events: c.events,
    createdAt: c.createdAt, updatedAt: c.updatedAt,
  };
  if (c.kind === 'bark') {
    return {
      ...base,
      bark: {
        serverUrl: c.bark?.serverUrl ?? '',
        // 只回「配没配」与末四位，够核对是不是自己给的那把，又不构成泄漏面。
        keySet: Boolean(c.bark?.key),
        keyTail: c.bark?.key ? c.bark.key.slice(-4) : '',
        group: c.bark?.group ?? '', sound: c.bark?.sound ?? '',
        level: c.bark?.level ?? '', call: Boolean(c.bark?.call),
      },
    };
  }
  if (c.kind === 'webhook') {
    return {
      ...base,
      webhook: {
        method: c.webhook?.method ?? 'POST',
        url: c.webhook?.url ?? '',
        contentType: c.webhook?.contentType ?? '',
        bodyTemplate: c.webhook?.bodyTemplate ?? '',
        // 请求头只回**名字**，不回值。名字是配置线索，值是密钥。
        headerNames: Object.keys(c.webhook?.headers ?? {}),
      },
    };
  }
  return {
    ...base,
    map: {
      endpoint: c.map?.endpoint ?? '', keyId: c.map?.keyId ?? '', username: c.map?.username ?? '',
      privateKeyFingerprint: c.map?.privateKey ? fingerprint(c.map.privateKey) : '',
    },
  };
}

class Invalid extends Error {}
const fail = (m: string): never => { throw new Invalid(m); };

function str(v: unknown, max = 512): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/**
 * 把请求体变成一条完整配置。
 *
 * `previous` 存在时走「留空 = 保持原值」：读接口从不回密钥，所以前端也交不回来，
 * 强求必填等于每改一次名字都要重敲一遍私钥——那种设计的结局是没人敢改。
 */
export function parseChannel(
  body: Record<string, unknown>,
  previous: AlarmChannelConfig | undefined,
  now: number,
): AlarmChannelConfig {
  const next = parseChannelConfig(body, previous, now);
  // 最近一次投递记录跟着配置走：改名、改事件不该把「验证过」抹掉。
  // 但换了投递目标（Bark key / Webhook 地址 / MAP 凭据）就是换了一个从没验证过的目的地，
  // 旧证明不能沿用——否则通道继续 healthy、自检继续绿，而新目的地一次都没通过（Codex #1543 P1）。
  if (previous?.lastDelivery && !alarmTransportChanged(previous, next)) next.lastDelivery = previous.lastDelivery;
  return next;
}

/** 投递目标变了没有：新旧指纹比一下。 */
export function alarmTransportChanged(previous: AlarmChannelConfig, next: AlarmChannelConfig): boolean {
  return alarmTransportFingerprint(previous) !== alarmTransportFingerprint(next);
}

function parseChannelConfig(
  body: Record<string, unknown>,
  previous: AlarmChannelConfig | undefined,
  now: number,
): AlarmChannelConfig {
  const kind = str(body.kind) as AlarmChannelKind;
  if (!KINDS.includes(kind)) fail(`协议只能是 ${KINDS.join(' / ')}`);
  if (previous && previous.kind !== kind) fail('已有通道不能改协议 —— 换协议等于换一条通道，请新建');

  const name = str(body.name, 64);
  if (!name) fail('给这条通道起个名字（「我的手机」「运维群」），出问题时你要认得出是谁响了');

  /*
   * 归一化而不是直接过滤：旧名字（不分来源的 recovered）要能继续提交，不逼调用方先迁移。
   *
   * 但**认不出来的名字必须当场拒**，不许静默丢掉。2026-09-15 亲身踩到：给一个跑着旧
   * 代码的后端提交 `business-recovered`，它默默把这一项滤掉、返回 200，订阅就这么被
   * 悄悄收窄了一半——我是因为顺手读了响应体才发现的。静默丢弃把一个本该立刻暴露的
   * 版本不匹配，变成了一条要等真出事那天才会显形的错。
   */
  const rawEvents = Array.isArray(body.events) ? body.events : [];
  const unknown = rawEvents.filter((e) => typeof e !== 'string' || normalizeEventKind(e) === null);
  if (unknown.length > 0) {
    fail(`认不出这些事件名：${unknown.map((e) => String(e)).join('、')}（可选：${ALARM_EVENT_KINDS.join(' / ')}）`);
  }
  const events = [...new Set(rawEvents
    .map((e) => normalizeEventKind(e as string))
    .filter((e): e is AlarmEventKind => e !== null))];
  // 空事件不是「静音」——静音靠 enabled。一条什么都不订的通道是一个从落地那天起
  // 就不会响的铃，而它在列表里看着和正常的一模一样。
  if (events.length === 0) fail('至少勾一类事件 —— 想临时静音请用开关，不要把事件清空');

  const projects = Array.isArray(body.projects)
    ? body.projects.map((p) => str(p, 128)).filter(Boolean)
    : [];

  const shell: AlarmChannelConfig = {
    id: previous?.id ?? crypto.randomUUID(),
    name, kind, projects, events,
    enabled: body.enabled === undefined ? (previous?.enabled ?? true) : Boolean(body.enabled),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };

  if (kind === 'bark') {
    const raw = (body.bark ?? {}) as Record<string, unknown>;
    const key = str(raw.key, 256) || previous?.bark?.key || '';
    if (!key) fail('Bark 的 key 必填 —— 在 Bark App 首页复制那串地址最后一段');
    const serverUrl = str(raw.serverUrl);
    if (serverUrl && !/^https:\/\//.test(serverUrl)) fail('自建 Bark 服务器必须是 https —— 通知里带着业务名，不能走明文');
    const level = str(raw.level, 32);
    if (level && !BARK_LEVELS.includes(level)) fail(`时效级别只能是 ${BARK_LEVELS.join(' / ')}`);
    shell.bark = {
      key, ...(serverUrl ? { serverUrl } : {}),
      ...(str(raw.group, 64) ? { group: str(raw.group, 64) } : {}),
      ...(str(raw.sound, 64) ? { sound: str(raw.sound, 64) } : {}),
      ...(level ? { level } : {}),
      ...(raw.call ? { call: true } : {}),
    };
    return shell;
  }

  if (kind === 'webhook') {
    const raw = (body.webhook ?? {}) as Record<string, unknown>;
    const url = str(raw.url, 1024);
    if (!url) fail('Webhook 地址必填');
    if (!/^https:\/\//.test(url)) fail('Webhook 地址必须是 https —— 通知里带着业务名，不能走明文');
    const method = METHODS.includes(str(raw.method) as typeof METHODS[number])
      ? (str(raw.method) as typeof METHODS[number]) : 'POST';
    const headers: Record<string, string> = { ...(previous?.webhook?.headers ?? {}) };
    if (raw.headers && typeof raw.headers === 'object') {
      for (const [k, v] of Object.entries(raw.headers as Record<string, unknown>)) {
        const name_ = k.trim();
        if (!/^[A-Za-z0-9-]{1,64}$/.test(name_)) fail(`请求头名字不合法：${k}`);
        const value = str(v, 1024);
        // 空值 = 删掉这个头（前端拿不到旧值，所以「留空保持」在这里要反过来：
        // 想删就明确交一个空串，想保持就整个不交这个 key）。
        if (value) headers[name_] = value;
        else delete headers[name_];
      }
    }
    if (Object.keys(headers).length > MAX_HEADERS) fail(`请求头最多 ${MAX_HEADERS} 个`);
    shell.webhook = {
      method, url,
      ...(str(raw.contentType, 128) ? { contentType: str(raw.contentType, 128) } : {}),
      ...(typeof raw.bodyTemplate === 'string' && raw.bodyTemplate.trim()
        ? { bodyTemplate: raw.bodyTemplate.slice(0, 4096) } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
    return shell;
  }

  const raw = (body.map ?? {}) as Record<string, unknown>;
  const endpoint = str(raw.endpoint, 512) || previous?.map?.endpoint || '';
  const keyId = str(raw.keyId, 128) || previous?.map?.keyId || '';
  const username = str(raw.username, 128) || previous?.map?.username || '';
  const privateKey = (typeof raw.privateKey === 'string' && raw.privateKey.trim())
    ? raw.privateKey.trim() : (previous?.map?.privateKey || '');
  const missing = (['endpoint', 'keyId', 'username', 'privateKey'] as const)
    .filter((k) => !({ endpoint, keyId, username, privateKey })[k]);
  if (missing.length > 0) fail(`MAP 通道四项缺一不可，还缺 ${missing.join('、')}`);
  if (!/^https:\/\//.test(endpoint)) fail('MAP 端点必须是 https');
  if (!/BEGIN [A-Z ]*PRIVATE KEY/.test(privateKey)) fail('私钥必须是 PKCS#8 PEM（BEGIN PRIVATE KEY）');
  shell.map = { endpoint, keyId, username, privateKey };
  return shell;
}

export function registerAlarmChannelRoutes(router: Router, deps: AlarmChannelRoutesDeps): void {
  /**
   * 读写同一道门：通知通道属于 CDS 系统设置，只许管理员会话或全权全局 Key。
   * 读接口也要拦——它回 webhook 地址（可能带 token）、Bark 密钥尾号、MAP 端点与用户名，
   * create-only 的全局 Key 虽然被全局网关放行了 GET，但不该看到这些（Codex #1543 P1）。
   */
  const denySystemAccess = (req: Request, res: Response): boolean => {
    const guard = assertUnscopedAdmin(req as unknown as Parameters<typeof assertUnscopedAdmin>[0]);
    if (!guard) return false;
    res.status(guard.status).json({ ...guard.body, hint: '通知通道属于 CDS 系统设置，项目级 / 带作用域的 Key 不可读写' });
    return true;
  };

  const views = (): AlarmChannelStatusView[] =>
    deps.list().map((c) => deps.ledger.view(c, channelConfigured(c)));

  router.get('/cds-system/alarm-channels', (req, res) => {
    if (denySystemAccess(req, res)) return;
    res.json({
      channels: deps.list().map(publicChannel),
      status: views(),
      events: ALARM_EVENT_KINDS,
      barkLevels: BARK_LEVELS,
    });
  });

  router.get('/cds-system/alarm-deliveries', async (req, res) => {
    if (denySystemAccess(req, res)) return;
    if (!deps.history?.findRecent) {
      res.status(503).json({ error: 'history_unavailable', message: '通知历史尚未启用，请检查服务器事件日志存储。' });
      return;
    }
    const hours = Number(req.query.hours ?? 24);
    if (![1, 24, 168].includes(hours)) {
      res.status(400).json({ error: 'invalid_range', message: '查询范围仅支持 1、24 或 168 小时。' });
      return;
    }
    const since = new Date(Date.now() - hours * 3600000).toISOString();
    try {
      const events = await deps.history.findRecent({ source: ALARM_HISTORY_SOURCE, since, limit: 1000 });
      res.json({ ...summarizeAlarmDeliveries(events), since, generatedAt: new Date().toISOString(),
        truncated: events.length >= 1000,
        note: '仅统计记录启用后保留的发送尝试；成功表示推送服务已接受，不代表手机已展示。达到上限时为部分统计。',
      });
    } catch {
      res.status(503).json({ error: 'history_unavailable', message: '通知历史暂时读取失败，请稍后重试。' });
    }
  });

  const write = (req: Request, res: Response, id?: string): void => {
    if (denySystemAccess(req, res)) return;
    const previous = id ? deps.list().find((c) => c.id === id) : undefined;
    if (id && !previous) { res.status(404).json({ error: '通道不存在' }); return; }
    try {
      const next = parseChannel((req.body || {}) as Record<string, unknown>, previous, Date.now());
      // 内存台账也要清：它按通道 id 记着上一次成功，换了目的地不清等于继续替新目的地说好话
      if (previous && alarmTransportChanged(previous, next)) deps.ledger.forget(next.id);
      deps.upsert(next);
      res.json({ channel: publicChannel(next), status: deps.ledger.view(next, channelConfigured(next)) });
    } catch (err) {
      if (err instanceof Invalid) res.status(400).json({ error: 'validation', message: err.message });
      else throw err;
    }
  };

  router.post('/cds-system/alarm-channels', (req, res) => write(req, res));
  router.put('/cds-system/alarm-channels/:id', (req, res) => write(req, res, req.params.id));

  router.delete('/cds-system/alarm-channels/:id', (req, res) => {
    if (denySystemAccess(req, res)) return;
    const gone = deps.remove(req.params.id);
    if (!gone) { res.status(404).json({ error: '通道不存在' }); return; }
    deps.ledger.forget(req.params.id);
    res.json({ ok: true, status: views() });
  });

  /**
   * 演练一条通道。
   *
   * 走**真实投递路径**——同一个渲染器、同一条协议分支、同一份凭据。
   * 只有同一条路才证明得了真出事那天它会通；单独写一条「测试发送」的捷径，
   * 测的是那条捷径。
   */
  router.post('/cds-system/alarm-channels/:id/drill', async (req, res) => {
    if (denySystemAccess(req, res)) return;
    const channel = deps.list().find((c) => c.id === req.params.id);
    if (!channel) { res.status(404).json({ error: '通道不存在' }); return; }
    const now = Date.now();
    const boardUrl = deps.boardUrl?.();
    const result = await sendAlarm(channel, drillEvent(now), { boardUrl, history: deps.history, deliveryKind: 'drill' });
    deps.ledger.record(channel.id, result, 'drill', now);
    res.json({ ...result, status: deps.ledger.view(channel, channelConfigured(channel)) });
  });
}
