import { useEffect, useMemo, useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useRemoteAssetsStore } from '../../stores/remoteAssetsStore';
import { useAuthStore } from '../../stores/authStore';

type AssetRow = {
  title: string;
  key: string; // 资源名（文件名/相对路径），Desktop 内置清单
  kind: 'image';
};

// Desktop 侧只存“需要的 key”，不存 URL 规则；URL 在页面按固定规则拼接
const REQUIRED_ASSETS: AssetRow[] = [
  { title: '冷启动加载', key: 'start_load.gif', kind: 'image' },
  { title: '加载动画', key: 'load.gif', kind: 'image' },
  // 规则确认：除皮肤目录外不允许再有子目录；因此 key 统一使用“文件名”
  { title: '登录 Logo', key: 'login_logo.svg', kind: 'image' },
  { title: '登录图标', key: 'login_icon.png', kind: 'image' },
];

function labelForSkin(skin: string): string {
  const s = String(skin || '').trim().toLowerCase();
  if (s === 'white') return '白天';
  if (s === 'dark') return '黑夜';
  return skin;
}

function buildIconUrl(baseUrl: string, key: string, skin?: string | null): string {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '');
  const k = String(key || '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\\/g, '')
    .replace(/\//g, ''); // 强约束：除 skin 目录外无子目录（key 仅文件名）
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
    // 规则：无论当前皮肤/是否切换，都要展示：
    // - 默认(base) 一列
    // - white/dark 两列（即使服务端未配置/暂时没返回，也用于“缺失/可用性”诊断）
    // - 其它皮肤列来自服务端下发 skins
    const raw = Array.isArray(skins) ? skins : [];
    const uniq = Array.from(new Set(raw.map((x) => String(x || '').trim()).filter(Boolean)));
    const tail = uniq
      .filter((x) => x !== 'white' && x !== 'dark')
      .sort((a, b) => a.localeCompare(b));
    return ['__base__', 'white', 'dark', ...tail];
  }, [skins]);

  const desktopRoot = useMemo(() => {
    const b = String(baseUrl || '').trim().replace(/\/+$/, '');
    return b ? `${b}/icon/desktop` : '';
  }, [baseUrl]);

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

      {/* 统一资源根目录（单独一行展示；hover 显示完整路径由每格 title 负责） */}
      <div className="px-4 py-2 border-b text-xs text-text-secondary">
        <div className="font-mono break-all">{desktopRoot || '-'}</div>
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
  const BOX = 96; // 统一正方形预览尺寸（所有资源一致）

  return (
    <>
      <div className="border-b px-4 py-4 text-sm text-text-secondary">
        <div className="font-medium text-text-primary">{row.title}</div>
        <div className="text-xs opacity-70 mt-1">{row.key}</div>
      </div>
      {columns.map((c) => {
        const skin = c === '__base__' ? null : c;
        const url = buildIconUrl(baseUrl, row.key, skin);
        const relPath = `${skin ? `${skin}/` : ''}${row.key}`;
        const id = `${row.key}@@${c}`;
        const isBroken = Boolean(broken?.[id]);
        return (
          <div key={id} className="border-b px-4 py-4">
            {row.kind === 'image' ? (
              <div className="flex flex-col gap-2">
                <div
                  className={`rounded-xl border ${isBroken ? 'border-red-500/50 bg-red-500/10' : 'border-black/10 dark:border-white/10'} p-2`}
                  style={{ width: `${BOX}px`, height: `${BOX}px` }}
                  title={url || ''}
                >
                  {url ? (
                    <img
                      src={url}
                      alt=""
                      aria-hidden="true"
                      className="block select-none pointer-events-none w-full h-full"
                      onError={() => onBroken(id)}
                      onLoad={() => onRecovered(id)}
                      style={{ objectFit: 'contain' }}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-xs text-text-secondary">无 URL</div>
                  )}
                </div>
                <div className={`text-sm ${isBroken ? 'text-red-600 dark:text-red-300' : 'text-text-secondary'}`}>
                  {isBroken ? '缺失/不可用' : '正常'}
                </div>
                <div className="text-xs text-text-secondary break-all" title={url || ''}>
                  {url ? relPath : '-'}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}


