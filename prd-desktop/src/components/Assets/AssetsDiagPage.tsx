import { useEffect, useMemo, useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useDesktopBrandingStore } from '../../stores/desktopBrandingStore';
import { useAuthStore } from '../../stores/authStore';

type AssetRow = {
  title: string;
  key: string; // 资源 key（不含扩展名）
  url: string; // 完整 URL
  kind: 'image';
};

export default function AssetsDiagPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'ADMIN';
  const setMode = useSessionStore((s) => s.setMode);

  const branding = useDesktopBrandingStore((s) => s.branding);
  const refreshBranding = useDesktopBrandingStore((s) => s.refresh);

  const [broken, setBroken] = useState<Record<string, boolean>>({});

  useEffect(() => {
    // 进入页后拉取最新的 branding 数据（包含所有资源 URL）
    void refreshBranding('assets-diag');
  }, [refreshBranding]);

  // 从 branding.assets 构建资源列表
  const rows = useMemo<AssetRow[]>(() => {
    const assets = branding.assets || {};
    return Object.entries(assets).map(([key, url]) => ({
      title: key, // 可以从后端获取 description，这里暂时用 key
      key,
      url,
      kind: 'image' as const,
    }));
  }, [branding.assets]);

  if (!isAdmin) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-secondary">
        无权限：仅管理员可查看资源诊断页
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-4 py-3 border-b ui-glass-bar flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            title="返回"
            onClick={() => setMode('QA')}
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="font-semibold text-text-primary">资源诊断</div>
          <div className="text-xs text-text-secondary">悬浮可查看完整 URL；资源由后端统一管理（含回退逻辑）</div>
        </div>

        <div className="flex items-center gap-2">
          <button
            className="px-3 py-2 text-sm rounded-xl ui-control hover:opacity-90"
            onClick={() => void refreshBranding('manual-refresh')}
            title="刷新资源列表"
          >
            刷新资源列表
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {rows.map((row) => (
            <div
              key={row.key}
              className="rounded-xl border border-black/10 dark:border-white/10 p-4 flex flex-col gap-3"
            >
              <div className="font-medium text-text-primary">{row.title}</div>
              <div
                className={`rounded-lg border ${broken[row.key] ? 'border-red-500/50 bg-red-500/10' : 'border-black/10 dark:border-white/10'} p-2 flex items-center justify-center bg-black/5 dark:bg-white/5`}
                style={{ width: '100%', height: '120px' }}
                title={row.url}
              >
                {row.url ? (
                  <img
                    src={row.url}
                    alt=""
                    aria-hidden="true"
                    className="block select-none pointer-events-none max-w-full max-h-full"
                    onError={() => setBroken((m) => ({ ...m, [row.key]: true }))}
                    onLoad={() => setBroken((m) => ({ ...m, [row.key]: false }))}
                    style={{ objectFit: 'contain' }}
                  />
                ) : (
                  <div className="text-xs text-text-secondary">无 URL</div>
                )}
              </div>
              <div className={`text-sm ${broken[row.key] ? 'text-red-600 dark:text-red-300' : 'text-green-600 dark:text-green-400'}`}>
                {broken[row.key] ? '缺失/不可用' : '正常'}
              </div>
              <div className="text-xs text-text-secondary break-all font-mono" title={row.url}>
                {row.url || '-'}
              </div>
            </div>
          ))}
          {rows.length === 0 && (
            <div className="col-span-full text-center text-text-secondary py-8">
              暂无资源数据，请先在 Admin 后台上传资源
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
