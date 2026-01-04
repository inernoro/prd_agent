import { useEffect, useMemo, useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useRemoteAssetsStore } from '../../stores/remoteAssetsStore';
import { useAuthStore } from '../../stores/authStore';

type AssetRow = {
  title: string;
  key: string; // 资源名（文件名/相对路径），Desktop 内置清单
  kind: 'image';
  size: number;
};

// Desktop 侧只存“需要的 key”，不存 URL 规则；URL 在页面按固定规则拼接
const REQUIRED_ASSETS: AssetRow[] = [
  { title: '加载动画', key: 'load.gif', kind: 'image', size: 92 },
  // 登录页目前 UI 还没用到图片资源，这里先约定 key，供你们后台替换验证
  { title: '登录 Logo', key: 'login/logo.svg', kind: 'image', size: 64 },
  { title: '登录图标', key: 'login/icon.png', kind: 'image', size: 64 },
];

function labelForSkin(skin: string): string {
  const s = String(skin || '').trim().toLowerCase();
  if (s === 'white') return '白天';
  if (s === 'dark') return '黑夜';
  return skin;
}

function buildIconUrl(baseUrl: string, key: string, skin?: string | null): string {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '');
  const k = String(key || '').trim().replace(/^\/+/, '');
  const s = String(skin || '').trim().replace(/^\/+|\/+$/g, '');
  if (!b || !k) return '';
  if (s) return `${b}/icon/desktop/${s}/${k}`;
  return `${b}/icon/desktop/${k}`;
}

export default function AssetsDiagPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'ADMIN';
  const setMode = useSessionStore((s) => s.setMode);

  const baseUrl = useRemoteAssetsStore((s) => s.baseUrl);
  const skins = useRemoteAssetsStore((s) => s.skins);
  const refreshSkins = useRemoteAssetsStore((s) => s.refreshSkinsFromServer);
  const resetCache = useRemoteAssetsStore((s) => s.resetLocalCacheAndRefresh);

  const [broken, setBroken] = useState<Record<string, boolean>>({});

  useEffect(() => {
    // 进入页后尝试拉一次 skins（失败不影响展示；没有 skins 时至少有默认列）
    void refreshSkins();
  }, [refreshSkins]);

  const columns = useMemo(() => {
    const uniq = Array.from(new Set((Array.isArray(skins) ? skins : []).map((x) => String(x || '').trim()).filter(Boolean)));
    // 保证 white/dark 在前（若存在）
    const head: string[] = [];
    if (uniq.includes('white')) head.push('white');
    if (uniq.includes('dark')) head.push('dark');
    const tail = uniq.filter((x) => x !== 'white' && x !== 'dark').sort((a, b) => a.localeCompare(b));
    return ['__base__', ...head, ...tail];
  }, [skins]);

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
          <div className="text-xs text-text-secondary">悬浮可查看源站地址；优先皮肤专有资源，不存在则回落默认</div>
        </div>

        <div className="flex items-center gap-2">
          <button
            className="px-3 py-2 text-sm rounded-xl ui-control hover:opacity-90"
            onClick={() => void refreshSkins()}
            title="重新获取皮肤列表"
          >
            重新获取皮肤
          </button>
          <button
            className="px-3 py-2 text-sm rounded-xl ui-control hover:opacity-90"
            onClick={() => void resetCache()}
            title="清空本地缓存并重新获取（不影响登录态）"
          >
            清空缓存并刷新
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        <div
          className="grid"
          style={{
            gridTemplateColumns: `160px repeat(${columns.length}, minmax(220px, 1fr))`,
          }}
        >
          {/* 表头 */}
          <div className="sticky top-0 z-10 bg-background-light dark:bg-background-dark border-b px-4 py-3 text-sm text-text-secondary">
            项目
          </div>
          {columns.map((c) => {
            const title = c === '__base__' ? '默认' : labelForSkin(c);
            return (
              <div
                key={c}
                className="sticky top-0 z-10 bg-background-light dark:bg-background-dark border-b px-4 py-3 text-sm font-semibold text-text-primary"
              >
                {title}
              </div>
            );
          })}

          {/* 行 */}
          {REQUIRED_ASSETS.map((row) => (
            <RowBlock
              key={row.key}
              row={row}
              columns={columns}
              baseUrl={baseUrl}
              broken={broken}
              onBroken={(id) => setBroken((m) => ({ ...(m || {}), [id]: true }))}
              onRecovered={(id) => setBroken((m) => ({ ...(m || {}), [id]: false }))}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function RowBlock(props: {
  row: AssetRow;
  columns: string[];
  baseUrl: string;
  broken: Record<string, boolean>;
  onBroken: (id: string) => void;
  onRecovered: (id: string) => void;
}) {
  const { row, columns, baseUrl, broken, onBroken, onRecovered } = props;

  return (
    <>
      <div className="border-b px-4 py-4 text-sm text-text-secondary">
        <div className="font-medium text-text-primary">{row.title}</div>
        <div className="text-xs opacity-70 mt-1">{row.key}</div>
      </div>
      {columns.map((c) => {
        const skin = c === '__base__' ? null : c;
        const url = buildIconUrl(baseUrl, row.key, skin);
        const id = `${row.key}@@${c}`;
        const isBroken = Boolean(broken?.[id]);
        return (
          <div key={id} className="border-b px-4 py-4">
            {row.kind === 'image' ? (
              <div className="flex items-center gap-3">
                <div
                  className={`rounded-xl border ${isBroken ? 'border-red-500/50 bg-red-500/10' : 'border-black/10 dark:border-white/10'} p-2`}
                  style={{ width: `${row.size + 16}px`, height: `${row.size + 16}px` }}
                  title={url || ''}
                >
                  {url ? (
                    <img
                      src={url}
                      alt=""
                      aria-hidden="true"
                      width={row.size}
                      height={row.size}
                      className="block select-none pointer-events-none"
                      onError={() => onBroken(id)}
                      onLoad={() => onRecovered(id)}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-xs text-text-secondary">无 URL</div>
                  )}
                </div>
                <div className="min-w-0">
                  <div className={`text-sm ${isBroken ? 'text-red-600 dark:text-red-300' : 'text-text-secondary'}`}>
                    {isBroken ? '缺失/不可用' : '正常'}
                  </div>
                  <div className="text-xs text-text-secondary truncate" title={url || ''}>
                    {url || '-'}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}


