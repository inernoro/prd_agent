import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useMemo } from 'react';
import { invoke } from '../lib/tauri';
import type { ApiResponse } from '../types';

export type RemoteAssetKind = 'image' | 'audio' | 'video' | 'other';
export type RemoteAssetId = 'icon.desktop.load' | 'icon.desktop.startLoad';

export type SkinName = string;

export type RemoteAssetSpec = {
  kind: RemoteAssetKind;
  /**
   * 资源路径（相对于 baseUrl）
   * - 仅保存 path，方便后续替换域名前缀（baseUrl）
   */
  path: string;
  /** 允许对单个资源直接覆盖成绝对 URL（用于灰度/临时切源） */
  absoluteUrlOverride?: string | null;
};

export type RemoteAssetMeta = {
  /** 最近一次成功 HEAD 到的 ETag（若服务端不提供则为空） */
  etag?: string | null;
  /** 最近一次成功 HEAD 到的 Last-Modified（若服务端不提供则为空） */
  lastModified?: string | null;
  /**
   * 变体不可用标记：
   * - 用于“皮肤资源不存在时不要每次都先撞 404 再回退”的体验优化
   * - 可通过“清空缓存并刷新”或后端 HEAD 成功自动恢复
   */
  unavailable?: boolean | null;
  /** 上次检查时间（ms） */
  lastCheckedAt?: number | null;
  /** 上次成功时间（ms） */
  lastOkAt?: number | null;
  /** 上次失败时间（ms） */
  lastFailAt?: number | null;
  /** 连续失败次数（用于简单退避） */
  failCount?: number | null;
};

type VariantKey = 'base' | `skin:${string}`;

type RemoteAssetEntry = RemoteAssetSpec & {
  /**
   * 资源元信息按 variant 存储：
   * - base：默认目录（/icon/desktop/load.gif）
   * - skin:{name}：皮肤专有目录（/icon/desktop/{name}/load.gif）
   *
   * 说明：不同 variant 可能来自不同文件，因此需要独立 etag/lastModified/versionToken。
   */
  metaByVariant?: Record<string, RemoteAssetMeta> | null;
};

const DEFAULT_BASE_URL = ''; // 默认为空，等待从 settingsStore (后端配置) 拉取或用户手动配置

const DEFAULT_ASSETS: Record<RemoteAssetId, RemoteAssetEntry> = {
  'icon.desktop.load': {
    kind: 'image',
    path: '/icon/desktop/load.gif',
    absoluteUrlOverride: null,
    metaByVariant: {
      base: {
        etag: null,
        lastModified: null,
        lastCheckedAt: null,
        lastOkAt: null,
        lastFailAt: null,
        failCount: 0,
      },
    },
  },
  'icon.desktop.startLoad': {
    kind: 'image',
    path: '/icon/desktop/start_load.gif',
    absoluteUrlOverride: null,
    metaByVariant: {
      base: {
        etag: null,
        lastModified: null,
        lastCheckedAt: null,
        lastOkAt: null,
        lastFailAt: null,
        failCount: 0,
      },
    },
  },
};

const STORAGE_KEY = 'remote-assets-storage';
const STORAGE_VERSION = 1;

const MIN_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h：冷启动时轻量检查一次，不打扰用户
const HEAD_TIMEOUT_MS = 1500;

function safeString(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : null;
}

function normalizeEtag(raw: string | null): string | null {
  const s = safeString(raw);
  if (!s) return null;
  // ETag 常见形式："abc" 或 W/"abc"
  return s.replace(/^W\//, '').replace(/^"+|"+$/g, '').trim() || null;
}

function normalizeSkin(raw: unknown): string | null {
  const s = safeString(raw);
  if (!s) return null;
  // 目录名：尽量保守，只做 trim；其余交由调用方控制
  return s;
}

function getMeta(entry: RemoteAssetEntry, key: VariantKey): RemoteAssetMeta {
  const m = entry.metaByVariant || {};
  const raw = (m as any)[key] as RemoteAssetMeta | undefined;
  return (raw && typeof raw === 'object') ? raw : {};
}

function setMeta(entry: RemoteAssetEntry, key: VariantKey, meta: RemoteAssetMeta): RemoteAssetEntry {
  const prev = entry.metaByVariant && typeof entry.metaByVariant === 'object' ? entry.metaByVariant : {};
  return {
    ...entry,
    metaByVariant: { ...(prev as any), [key]: meta },
  };
}

function buildSkinPath(basePath: string, skin: string): string {
  const p = String(basePath || '').trim();
  const s = String(skin || '').trim();
  if (!p || !s) return p;
  // 将 skin 插入到文件名前：/icon/desktop/load.gif -> /icon/desktop/{skin}/load.gif
  return p.replace(/\/([^/]+)$/, `/${s}/$1`);
}

function buildUrl(baseUrl: string, entry: RemoteAssetEntry, key: VariantKey, skin: string | null): string {
  const abs = safeString(entry.absoluteUrlOverride);
  if (abs) return abs;

  const b = String(baseUrl || '').trim().replace(/\/+$/, '');
  const basePath = String(entry.path || '').trim().startsWith('/') ? String(entry.path || '').trim() : `/${String(entry.path || '').trim()}`;
  const variantPath = key === 'base' ? basePath : buildSkinPath(basePath, skin || '');
  return `${b}${variantPath}`;
}

function withVersion(url: string, versionToken: string | null): string {
  const u = String(url || '').trim();
  const v = safeString(versionToken);
  if (!u || !v) return u;
  const hasQuery = u.includes('?');
  const sep = hasQuery ? '&' : '?';
  return `${u}${sep}v=${encodeURIComponent(v)}`;
}

function computeVersionToken(meta: RemoteAssetMeta): string | null {
  // 优先使用稳定的版本标识（避免每次启动都强制刷新）
  const et = normalizeEtag((meta as any)?.etag ?? null);
  if (et) return et;
  const lm = safeString((meta as any)?.lastModified ?? null);
  if (lm) return lm;
  // 若服务端不给 ETag/Last-Modified，则以最近一次成功时间兜底（确保“不会永远不变”）
  const okAt =
    typeof (meta as any)?.lastOkAt === 'number' && Number.isFinite((meta as any).lastOkAt)
      ? String(Math.floor((meta as any).lastOkAt))
      : null;
  return okAt;
}

async function headWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), Math.max(200, timeoutMs));
  try {
    return await fetch(url, { method: 'HEAD', cache: 'no-store', signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

export type RemoteAssetsState = {
  baseUrl: string;
  /** 当前皮肤名（用于优先尝试 /{skin}/xxx）；允许扩展为更多皮肤 */
  skin: SkinName | null;
  /** 服务端下发的皮肤列表（Desktop 只消费 skin 名，不消费地址规则） */
  skins: SkinName[];
  skinsUpdatedAt: number | null;
  assets: Record<RemoteAssetId, RemoteAssetEntry>;
  /**
   * 冷启动检查时间按 variant 存储（避免切换皮肤后“被 base 的时间戳挡住”）
   * - base
   * - skin:{name}
   */
  lastGlobalCheckedAtByVariant: Record<string, number> | null;

  setBaseUrl: (baseUrl: string) => void;
  setSkin: (skin: SkinName | null) => void;
  setSkins: (skins: SkinName[]) => void;
  refreshSkinsFromServer: () => Promise<void>;
  resetLocalCacheAndRefresh: () => Promise<void>;
  markSkinVariantUnavailable: (id: RemoteAssetId, skin: SkinName | null) => void;
  getAssetUrl: (id: RemoteAssetId, args?: { variant?: 'base' | 'skin'; skin?: SkinName | null }) => string;
  refreshOnColdStart: () => Promise<void>;
};

export const useRemoteAssetsStore = create<RemoteAssetsState>()(
  persist(
    (set, get) => ({
      baseUrl: DEFAULT_BASE_URL,
      skin: 'white',
      skins: [],
      skinsUpdatedAt: null,
      assets: DEFAULT_ASSETS,
      lastGlobalCheckedAtByVariant: null,

      setBaseUrl: (baseUrl) => set(() => ({ baseUrl: String(baseUrl || '').trim() || DEFAULT_BASE_URL })),

      setSkin: (skin) => set(() => ({ skin: normalizeSkin(skin) })),

      setSkins: (skins) => set(() => ({
        skins: Array.from(new Set((Array.isArray(skins) ? skins : []).map((x) => normalizeSkin(x)).filter(Boolean))) as string[],
        skinsUpdatedAt: Date.now(),
      })),

      refreshSkinsFromServer: async () => {
        try {
          // Rust 侧需要实现该命令：GET /api/v1/assets/desktop/skins
          const resp = await invoke<ApiResponse<{ skins: string[] }>>('get_desktop_asset_skins');
          if (!resp || resp.success !== true) return;
          const data = resp.data;
          if (!data || !Array.isArray(data.skins)) return;
          set(() => ({
            skins: Array.from(new Set(data.skins.map((x) => normalizeSkin(x)).filter(Boolean))) as string[],
            skinsUpdatedAt: Date.now(),
          }));
        } catch {
          // ignore：断连/服务不可用不打扰用户
        }
      },

      resetLocalCacheAndRefresh: async () => {
        // Desktop 允许“删除本地重新获取”：不影响登录态，仅清理远端资源缓存与 skins 缓存
        set(() => ({
          assets: DEFAULT_ASSETS,
          lastGlobalCheckedAtByVariant: null,
          skins: [],
          skinsUpdatedAt: null,
        }));
        try {
          await get().refreshSkinsFromServer();
        } catch {
          // ignore
        }
        try {
          await get().refreshOnColdStart();
        } catch {
          // ignore
        }
      },

      markSkinVariantUnavailable: (id, skin) => {
        const s = normalizeSkin(skin);
        if (!s) return;
        const key: VariantKey = `skin:${s}`;
        set((prev) => {
          const entry = prev.assets?.[id] ?? DEFAULT_ASSETS[id];
          const meta = getMeta(entry, key);
          const nextMeta: RemoteAssetMeta = {
            ...meta,
            unavailable: true,
            lastFailAt: Date.now(),
            failCount: Math.min(20, (typeof (meta as any).failCount === 'number' ? (meta as any).failCount : 0) + 1),
          };
          return { assets: { ...(prev.assets || DEFAULT_ASSETS), [id]: setMeta(entry, key, nextMeta) } };
        });
      },

      getAssetUrl: (id, args) => {
        const state = get();
        const entry = state.assets?.[id] ?? DEFAULT_ASSETS[id];
        const want = args?.variant === 'skin' ? 'skin' : 'base';
        const skin = normalizeSkin(args?.skin ?? state.skin);
        const key: VariantKey = want === 'skin' && skin ? (`skin:${skin}` as VariantKey) : 'base';
        const raw = buildUrl(state.baseUrl, entry, key, skin);
        const meta = getMeta(entry, key);
        return withVersion(raw, computeVersionToken(meta));
      },

      refreshOnColdStart: async () => {
        const now = Date.now();
        const state = get();
        const ids = Object.keys(state.assets || {}) as RemoteAssetId[];
        if (ids.length === 0) return;

        const skin = normalizeSkin(state.skin);
        const variants: Array<{ key: VariantKey; skin: string | null }> = [{ key: 'base', skin: null }];
        if (skin) variants.push({ key: `skin:${skin}` as VariantKey, skin });

        const lastMap = (state.lastGlobalCheckedAtByVariant && typeof state.lastGlobalCheckedAtByVariant === 'object')
          ? state.lastGlobalCheckedAtByVariant
          : {};
        const shouldCheckVariant = (key: VariantKey) => {
          const last = typeof (lastMap as any)[key] === 'number' ? (lastMap as any)[key] : null;
          return !(last && now - last < MIN_CHECK_INTERVAL_MS);
        };

        const variantsToCheck = variants.filter((v) => shouldCheckVariant(v.key));
        if (variantsToCheck.length === 0) return;

        // 并行 HEAD；失败不抛，确保“冷启动不受影响”
        const jobs = variantsToCheck.flatMap((variant) =>
          ids.map(async (id) => {
            const entry = get().assets?.[id] ?? DEFAULT_ASSETS[id];
            const url = buildUrl(get().baseUrl, entry, variant.key, variant.skin);
            try {
              const resp = await headWithTimeout(url, HEAD_TIMEOUT_MS);
              if (!resp.ok) {
                throw new Error(`HEAD ${resp.status}`);
              }
              const etag = normalizeEtag(resp.headers.get('etag'));
              const lastModified = safeString(resp.headers.get('last-modified'));
              return { ok: true as const, id, key: variant.key, etag, lastModified };
            } catch (err) {
              return { ok: false as const, id, key: variant.key, error: err };
            }
          })
        );
        const results = await Promise.all(jobs);

        set((prev) => {
          const nextAssets: Record<RemoteAssetId, RemoteAssetEntry> = { ...(prev.assets || DEFAULT_ASSETS) };
          const nextLastMap: Record<string, number> = {
            ...(prev.lastGlobalCheckedAtByVariant && typeof prev.lastGlobalCheckedAtByVariant === 'object'
              ? prev.lastGlobalCheckedAtByVariant
              : {}),
          };

          for (const r of results) {
            const checkedAt = now;
            if (r.ok) {
              const { id, key, etag, lastModified } = r;
              const prevEntry = nextAssets[id] ?? DEFAULT_ASSETS[id];
              const prevMeta = getMeta(prevEntry, key as VariantKey);
              const nextMeta: RemoteAssetMeta = {
                ...prevMeta,
                unavailable: false,
                etag: etag ?? (prevMeta as any).etag ?? null,
                lastModified: lastModified ?? (prevMeta as any).lastModified ?? null,
                lastCheckedAt: checkedAt,
                lastOkAt: checkedAt,
                lastFailAt: (prevMeta as any).lastFailAt ?? null,
                failCount: 0,
              };
              nextAssets[id] = setMeta(prevEntry, key as VariantKey, nextMeta);
              nextLastMap[key] = checkedAt;
            } else {
              const { id, key } = r;
              const prevEntry = nextAssets[id] ?? DEFAULT_ASSETS[id];
              const prevMeta = getMeta(prevEntry, key as VariantKey);
              const prevFail = typeof (prevMeta as any).failCount === 'number' && Number.isFinite((prevMeta as any).failCount)
                ? (prevMeta as any).failCount
                : 0;
              const nextMeta: RemoteAssetMeta = {
                ...prevMeta,
                // 失败不强行置 unavailable：可能是网络波动；真正“不存在”由 img onError 触发记录
                lastCheckedAt: checkedAt,
                lastFailAt: checkedAt,
                failCount: Math.min(20, prevFail + 1),
              };
              nextAssets[id] = setMeta(prevEntry, key as VariantKey, nextMeta);
            }
          }

          // 仅记录“本次冷启动尝试过的 variant”的时间戳（无论成功/失败，避免反复打 HEAD）
          variantsToCheck.forEach((v) => {
            nextLastMap[v.key] = now;
          });

          return { assets: nextAssets, lastGlobalCheckedAtByVariant: nextLastMap };
        });
      },
    }),
    {
      name: STORAGE_KEY,
      version: STORAGE_VERSION,
      partialize: (s) => ({
        baseUrl: s.baseUrl,
        skin: s.skin,
        skins: s.skins,
        skinsUpdatedAt: s.skinsUpdatedAt,
        assets: s.assets,
        lastGlobalCheckedAtByVariant: s.lastGlobalCheckedAtByVariant,
      }),
      merge: (persisted: any, current) => {
        const p = (persisted as any) || {};
        const baseUrl = safeString(p?.baseUrl) ?? (current as any).baseUrl ?? DEFAULT_BASE_URL;
        const skin = normalizeSkin(p?.skin ?? (current as any).skin);
        const skins = Array.isArray(p?.skins) ? p.skins : (current as any).skins;
        const skinsUpdatedAt =
          typeof p?.skinsUpdatedAt === 'number' && Number.isFinite(p.skinsUpdatedAt) ? p.skinsUpdatedAt : (current as any).skinsUpdatedAt ?? null;
        const assets = (p?.assets && typeof p.assets === 'object') ? (p.assets as any) : {};
        // 仅允许已知 id；未知字段丢弃，避免“脏数据污染”
        const mergedAssets: Record<RemoteAssetId, RemoteAssetEntry> = { ...DEFAULT_ASSETS };
        (Object.keys(DEFAULT_ASSETS) as RemoteAssetId[]).forEach((id) => {
          const fromPersist = assets?.[id] ?? null;
          if (!fromPersist || typeof fromPersist !== 'object') return;
          const baseEntry: RemoteAssetEntry = {
            ...DEFAULT_ASSETS[id],
            ...fromPersist,
            path: safeString(fromPersist.path) ?? DEFAULT_ASSETS[id].path,
            absoluteUrlOverride: safeString(fromPersist.absoluteUrlOverride) ?? null,
          };

          // 兼容旧结构：如果存在顶层 etag/lastModified 等字段，则写入 metaByVariant.base
          const legacyMeta: RemoteAssetMeta = {
            etag: safeString(fromPersist.etag) ?? null,
            lastModified: safeString(fromPersist.lastModified) ?? null,
            lastCheckedAt: typeof fromPersist.lastCheckedAt === 'number' ? fromPersist.lastCheckedAt : null,
            lastOkAt: typeof fromPersist.lastOkAt === 'number' ? fromPersist.lastOkAt : null,
            lastFailAt: typeof fromPersist.lastFailAt === 'number' ? fromPersist.lastFailAt : null,
            failCount: typeof fromPersist.failCount === 'number' ? fromPersist.failCount : 0,
          };

          const metaByVariant = (fromPersist.metaByVariant && typeof fromPersist.metaByVariant === 'object')
            ? fromPersist.metaByVariant
            : null;

          const mergedMetaByVariant: Record<string, RemoteAssetMeta> = {
            ...(DEFAULT_ASSETS[id].metaByVariant || {}),
            ...(metaByVariant || {}),
          };
          // 若旧字段存在且新结构没有 base，则补上
          if (!mergedMetaByVariant.base && (legacyMeta.etag || legacyMeta.lastModified || legacyMeta.lastCheckedAt || legacyMeta.lastOkAt)) {
            mergedMetaByVariant.base = legacyMeta;
          }

          mergedAssets[id] = {
            ...baseEntry,
            metaByVariant: mergedMetaByVariant,
          };
        });

        // 兼容：旧字段 lastGlobalCheckedAt -> lastGlobalCheckedAtByVariant.base
        const legacyLast =
          typeof p?.lastGlobalCheckedAt === 'number' && Number.isFinite(p.lastGlobalCheckedAt) ? p.lastGlobalCheckedAt : null;
        const lastGlobalCheckedAtByVariant =
          (p?.lastGlobalCheckedAtByVariant && typeof p.lastGlobalCheckedAtByVariant === 'object')
            ? (p.lastGlobalCheckedAtByVariant as Record<string, number>)
            : (legacyLast ? ({ base: legacyLast } as Record<string, number>) : null);

        return {
          ...(current as any),
          baseUrl,
          skin,
          skins: Array.from(new Set((Array.isArray(skins) ? skins : []).map((x) => normalizeSkin(x)).filter(Boolean))) as string[],
          skinsUpdatedAt,
          assets: mergedAssets,
          lastGlobalCheckedAtByVariant,
        } as RemoteAssetsState;
      },
    }
  )
);

/**
 * 订阅某个资源的 URL（当对应 variant 的 meta 更新时会触发重渲染）
 */
export function useRemoteAssetUrl(id: RemoteAssetId, args?: { variant?: 'base' | 'skin'; skin?: SkinName | null }): string {
  return useRemoteAssetsStore((s) => {
    const entry = s.assets?.[id] ?? DEFAULT_ASSETS[id];
    const want = args?.variant === 'skin' ? 'skin' : 'base';
    const skin = normalizeSkin(args?.skin ?? s.skin);
    const key: VariantKey = want === 'skin' && skin ? (`skin:${skin}` as VariantKey) : 'base';
    const raw = buildUrl(s.baseUrl, entry, key, skin);
    const meta = getMeta(entry, key);
    return withVersion(raw, computeVersionToken(meta));
  });
}

export function useRemoteAssetUrlPair(id: RemoteAssetId, args?: { skin?: SkinName | null }): { skinUrl: string; baseUrl: string } {
  const baseUrl = useRemoteAssetUrl(id, { variant: 'base' });
  const skinUrl = useRemoteAssetUrl(id, { variant: 'skin', skin: args?.skin ?? null });
  return { skinUrl, baseUrl };
}

export function useIsSkinVariantUnavailable(id: RemoteAssetId): { skin: string | null; unavailable: boolean } {
  const skin = useRemoteAssetsStore((s) => normalizeSkin(s.skin));
  const unavailable = useRemoteAssetsStore((s) => {
    const skin = normalizeSkin(s.skin);
    if (!skin) return false;
    const entry = s.assets?.[id] ?? DEFAULT_ASSETS[id];
    const key: VariantKey = `skin:${skin}`;
    const meta = getMeta(entry, key);
    return Boolean((meta as any)?.unavailable);
  });
  return useMemo(() => ({ skin, unavailable }), [skin, unavailable]);
}


