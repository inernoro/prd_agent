import { useEffect, useMemo, useState } from 'react';
import { isTauri } from '../../lib/tauri';
import {
  LAST_VERSION_KEY,
  POST_UPDATE_PENDING_VERSION_KEY,
  SEEN_PREFIX,
  normalizeDesktopVersion,
  postUpdateSeenKey,
  shouldShowPostUpdateSummary,
} from '../../lib/postUpdateSummary';

interface RecentUpdateItem {
  date: string;
  type: string;
  module: string;
  description: string;
}

interface LatestRelease {
  version: string;
  date: string | null;
  highlights: string[];
}

interface RecentUpdatesPayload {
  generatedAt: string;
  windowDays: number;
  latestRelease?: LatestRelease | null;
  items: RecentUpdateItem[];
}

const EXISTING_INSTALL_KEYS = [
  'auth-storage',
  'session-storage',
  'ui-prefs-storage',
  'prd-skill-store',
  'prd-citation-preview-storage',
  'prd-desktop-theme',
  'prdAgent.sidebarWidth',
];

function readStorage(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function removeStorage(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function hasExistingDesktopState() {
  try {
    if (EXISTING_INSTALL_KEYS.some((key) => window.localStorage.getItem(key) != null)) {
      return true;
    }

    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i) || '';
      if (
        key.startsWith('prd-') &&
        key !== LAST_VERSION_KEY &&
        key !== POST_UPDATE_PENDING_VERSION_KEY &&
        !key.startsWith(SEEN_PREFIX)
      ) {
        return true;
      }
    }
  } catch {
    return false;
  }

  return false;
}

export default function PostUpdateSummaryModal() {
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [payload, setPayload] = useState<RecentUpdatesPayload | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;

    (async () => {
      try {
        const { getVersion } = await import('@tauri-apps/api/app');
        const version = normalizeDesktopVersion(await getVersion());
        if (!version || cancelled) return;

        const lastVersion = normalizeDesktopVersion(readStorage(LAST_VERSION_KEY));
        const pendingVersion = normalizeDesktopVersion(readStorage(POST_UPDATE_PENDING_VERSION_KEY));
        const alreadySeen = readStorage(postUpdateSeenKey(version)) === '1';
        const shouldShow = shouldShowPostUpdateSummary({
          currentVersion: version,
          lastVersion,
          pendingVersion,
          alreadySeen,
          hasExistingDesktopState: hasExistingDesktopState(),
        });

        if (shouldShow) {
          setCurrentVersion(version);
          setOpen(true);
          try {
            const resp = await fetch('/recent-updates.json', { cache: 'no-cache' });
            if (resp.ok && !cancelled) {
              setPayload(await resp.json());
            }
          } catch {
            // 更新说明拉取失败不影响面板展示
          }
          return;
        }

        writeStorage(LAST_VERSION_KEY, version);
        if (pendingVersion) removeStorage(POST_UPDATE_PENDING_VERSION_KEY);
      } catch {
        // 版本读取失败时保持安静
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const release = payload?.latestRelease;
  const fallbackItems = payload?.items ?? [];
  const titleVersion = currentVersion || normalizeDesktopVersion(release?.version) || '新版本';
  const highlights = useMemo(() => {
    if (release?.highlights?.length) return release.highlights.slice(0, 6);
    return fallbackItems.slice(0, 6).map((item) => item.description);
  }, [fallbackItems, release?.highlights]);

  const close = () => {
    const version = titleVersion;
    if (version && version !== '新版本') {
      writeStorage(postUpdateSeenKey(version), '1');
      writeStorage(LAST_VERSION_KEY, version);
      removeStorage(POST_UPDATE_PENDING_VERSION_KEY);
    }
    setOpen(false);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[998] flex items-center justify-center px-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
        onClick={close}
        aria-label="关闭更新说明"
      />

      <section className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-white/15 bg-slate-950/90 text-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-white/10 px-6 py-5">
          <div className="min-w-0">
            <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-cyan-300/25 bg-cyan-400/10 px-2.5 py-1 text-[11px] font-semibold text-cyan-100">
              <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M4 10.5l3.4 3.4L16 5.3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              更新已完成
            </div>
            <h2 className="text-xl font-semibold leading-7">PRD Agent Desktop 已更新到 v{titleVersion}</h2>
            <p className="mt-1 text-sm leading-6 text-white/60">
              {release?.date ? `${release.date} 发布` : '本次启动后首次展示'}
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            className="shrink-0 rounded-lg p-2 text-white/55 transition-colors hover:bg-white/10 hover:text-white"
            aria-label="关闭"
            title="关闭"
          >
            <svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5">
          <div className="mb-3 text-sm font-medium text-white/75">本次更新内容</div>
          {highlights.length > 0 ? (
            <ul className="space-y-3">
              {highlights.map((item, index) => (
                <li key={`${index}-${item}`} className="flex gap-3">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-300" />
                  <span className="text-sm leading-6 text-white/82">{item}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm leading-6 text-white/70">本次更新已安装完成，详细记录稍后可在更新中心查看。</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-white/10 px-6 py-4">
          <button
            type="button"
            onClick={close}
            className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-cyan-500/20 transition-colors hover:bg-cyan-400"
          >
            我知道了
          </button>
        </div>
      </section>
    </div>
  );
}
