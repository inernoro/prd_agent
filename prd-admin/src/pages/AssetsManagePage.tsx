import { useEffect, useMemo, useRef, useState } from 'react';
import { createDesktopAssetKey, createDesktopAssetSkin, deleteDesktopAssetKey, getDesktopBrandingSettings, getDesktopAssetsMatrix, listDesktopAssetSkins, updateDesktopBrandingSettings, uploadDesktopAsset, uploadNoHeadAvatar } from '@/services';
import type { AdminDesktopAssetMatrixRow, DesktopAssetSkin } from '@/services/contracts/desktopAssets';

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(' ');
}

type AssetKind = 'image' | 'audio' | 'video' | 'other';

type AssetRow = {
  id?: string;
  title: string;
  key: string;
  kind: AssetKind;
  description?: string | null;
  required?: boolean;
};

// 已被 Desktop 端硬编码/默认配置引用的 key（这些 key 不能删除）
// 来源：
// - prd-desktop/src/stores/remoteAssetsStore.ts: load, start_load
// - prd-desktop/src/stores/desktopBrandingStore.ts: 默认 loginIconKey=login_icon
const USED_ASSET_KEYS = new Set<string>(['load', 'start_load', 'login_icon']);

// 有“品牌配置”后，这两个 key 的单独行展示会显得重复（仍可通过品牌配置上传/或手动新建 key 上传）
import { getAvatarBaseUrl, resolveNoHeadAvatarUrl } from '@/lib/avatar';

function appendCacheBust(url: string, cacheBust: number): string {
  const u = String(url || '').trim();
  if (!u) return '';
  const v = typeof cacheBust === 'number' && Number.isFinite(cacheBust) ? String(Math.floor(cacheBust)) : '';
  if (!v) return u;
  return u.includes('?') ? `${u}&v=${encodeURIComponent(v)}` : `${u}?v=${encodeURIComponent(v)}`;
}

const HIDDEN_ASSET_KEYS = new Set<string>([]);

function getBaseAssetsUrl() {
  return getAvatarBaseUrl() || 'https://i.pa.759800.com'; // 兜底旧域名，避免完全空白
}

function labelForSkin(name: string) {
  const s = String(name || '').trim().toLowerCase();
  if (s === 'white') return '白天';
  if (s === 'dark') return '黑夜';
  return name;
}

function normalizeSkinName(raw: string): { ok: boolean; value: string; error?: string } {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return { ok: false, value: s, error: '皮肤名不能为空' };
  if (s.length > 32) return { ok: false, value: s, error: '皮肤名不能超过 32 字符' };
  if (!/^[a-z0-9][a-z0-9\-_]{0,31}$/.test(s)) {
    return { ok: false, value: s, error: '皮肤名仅允许小写字母/数字/中划线/下划线，且需以字母或数字开头' };
  }
  return { ok: true, value: s };
}

/**
 * 对齐 Desktop 端规则：
 * - URL 固定拼接为 /icon/desktop/<skin?>/<key>
 * - key 强约束为“仅文件名”（不允许子目录），并且全小写
 */
function normalizeDesktopKey(raw: string): { ok: boolean; value: string; error?: string } {
  const s = String(raw || '').trim().toLowerCase().replace(/^\/+/, '');
  if (!s) return { ok: false, value: s, error: 'key 不能为空' };
  if (s.length > 128) return { ok: false, value: s, error: 'key 不能超过 128 字符' };
  if (s.includes('..')) return { ok: false, value: s, error: 'key 不允许包含 ..' };
  if (s.includes('\\')) return { ok: false, value: s, error: 'key 不允许包含反斜杠' };
  if (s.includes('/')) return { ok: false, value: s, error: 'Desktop 端 key 仅支持文件名（不允许包含 / 子目录）' };
  if (!/^[a-z0-9][a-z0-9_\-.]{0,127}$/.test(s)) {
    return { ok: false, value: s, error: 'key 仅允许小写字母/数字/下划线/中划线/点，且需以字母或数字开头' };
  }
  return { ok: true, value: s };
}

async function copyText(s: string) {
  const text = String(s || '');
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

export default function AssetsManagePage() {
  const [activeTab, setActiveTab] = useState<'desktop' | 'single'>('desktop');
  const [skins, setSkins] = useState<DesktopAssetSkin[]>([]);
  const [matrixData, setMatrixData] = useState<AdminDesktopAssetMatrixRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const [brandingName, setBrandingName] = useState('PRD Agent');
  const [brandingSubtitle, setBrandingSubtitle] = useState('智能PRD解读助手');
  const [brandingWindowTitle, setBrandingWindowTitle] = useState('PRD Agent');
  const [brandingIconKey, setBrandingIconKey] = useState('login_icon');
  const [brandingBgKey, setBrandingBgKey] = useState('bg');
  const [brandingSaving, setBrandingSaving] = useState(false);

  const [cacheBust, setCacheBust] = useState<number>(() => Date.now());
  const [broken, setBroken] = useState<Record<string, boolean>>({});

  const [newSkin, setNewSkin] = useState('white');
  const [newKey, setNewKey] = useState('load');
  const [newKeyKind, setNewKeyKind] = useState<AssetKind>('image');
  const [newKeyDesc, setNewKeyDesc] = useState('');

  const [uploadingId, setUploadingId] = useState<string>('');
  const [uploadTarget, setUploadTarget] = useState<{ skin: string | null; key: string; mode?: 'matrix' | 'nohead' } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const reload = async () => {
    setLoading(true);
    setErr('');
    try {
      const [sRes, bRes, mRes] = await Promise.all([
        listDesktopAssetSkins(),
        getDesktopBrandingSettings(),
        getDesktopAssetsMatrix(),
      ]);
      if (!sRes.success) throw new Error(sRes.error?.message || '加载 skins 失败');
      setSkins(Array.isArray(sRes.data) ? sRes.data : []);
      setMatrixData(Array.isArray(mRes.data) ? mRes.data : []);
      if (bRes.success && bRes.data) {
        setBrandingName(String(bRes.data.desktopName || 'PRD Agent'));
        setBrandingSubtitle(String(bRes.data.desktopSubtitle || '智能PRD解读助手'));
        setBrandingWindowTitle(String(bRes.data.windowTitle || bRes.data.desktopName || 'PRD Agent'));
        // 自动移除扩展名
        let iconKey = String(bRes.data.loginIconKey || 'login_icon');
        if (iconKey.includes('.')) iconKey = iconKey.substring(0, iconKey.lastIndexOf('.'));
        setBrandingIconKey(iconKey);
        
        let bgKey = String(bRes.data.loginBackgroundKey || 'bg');
        if (bgKey.includes('.')) bgKey = bgKey.substring(0, bgKey.lastIndexOf('.'));
        setBrandingBgKey(bgKey);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e || '加载失败'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const saveBranding = async () => {
    setBrandingSaving(true);
    setErr('');
    try {
      const name = String(brandingName || '').trim();
      const subtitle = String(brandingSubtitle || '').trim();
      const winTitle = String(brandingWindowTitle || '').trim();
      
      // 自动移除扩展名
      let key = String(brandingIconKey || '').trim().toLowerCase().replace(/^\/+/, '').replace(/\\/g, '').replace(/\//g, '');
      if (key.includes('.')) key = key.substring(0, key.lastIndexOf('.'));
      
      let bgKey = String(brandingBgKey || '').trim().toLowerCase().replace(/^\/+/, '').replace(/\\/g, '').replace(/\//g, '');
      if (bgKey.includes('.')) bgKey = bgKey.substring(0, bgKey.lastIndexOf('.'));
      
      const res = await updateDesktopBrandingSettings({
        desktopName: name || 'PRD Agent',
        desktopSubtitle: subtitle || '智能PRD解读助手',
        windowTitle: winTitle || (name || 'PRD Agent'),
        loginIconKey: key || 'login_icon',
        loginBackgroundKey: bgKey || 'bg',
      });
      if (!res.success) throw new Error(res.error?.message || '保存失败');
      // 刷新，确保与后端最终值一致（含截断/规范化）
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e || '保存失败'));
    } finally {
      setBrandingSaving(false);
    }
  };

  const enabledSkins = useMemo(() => {
    return (Array.isArray(skins) ? skins : []).filter((s) => s.enabled).map((s) => String(s.name || '').trim()).filter(Boolean);
  }, [skins]);

  const columns = useMemo(() => {
    // 对齐 desktop：固定展示 base/white/dark；其它列来自服务端 enabled skins（去重并排序）
    const uniq = Array.from(new Set(enabledSkins.map((x) => String(x || '').trim()).filter(Boolean)));
    const tail = uniq.filter((x) => x !== 'white' && x !== 'dark').sort((a, b) => a.localeCompare(b));
    return ['__base__', 'white', 'dark', ...tail];
  }, [enabledSkins]);

  const rows: AssetRow[] = useMemo(() => {
    // 直接从 matrixData 构建 rows（后端已返回所有资源，包括必需的）
    const allRows: AssetRow[] = matrixData
      .map((m) => ({
        id: m.id || undefined,
        key: m.key,
        title: m.description || m.name || m.key,
        kind: (m.kind as AssetKind) || 'image',
        description: m.description || null,
        required: m.required || USED_ASSET_KEYS.has(m.key),
      }))
      .filter((r) => !HIDDEN_ASSET_KEYS.has(String(r.key || '').trim().toLowerCase()));

    // 确保品牌配置的 key 也在列表中展示（如果 matrixData 中没有）
    const existingKeys = new Set(allRows.map((r) => r.key));
    const brandingKeys = [
      { key: brandingIconKey, title: '登录图标（配置项）', description: '当前品牌配置使用的 Key' },
      { key: brandingBgKey, title: '登录背景（配置项）', description: '当前品牌配置使用的 Key' },
    ];

    brandingKeys.forEach(({ key, title, description }) => {
      const k = String(key || '').trim();
      if (k && !existingKeys.has(k)) {
        allRows.push({
          title,
          key: k,
          kind: 'image',
          description,
          required: true,
        });
        existingKeys.add(k);
      }
    });

    return allRows;
  }, [matrixData, brandingIconKey, brandingBgKey]);

  const desktopRoot = useMemo(() => {
    const b = String(getBaseAssetsUrl() || '').trim().replace(/\/+$/, '');
    return b ? `${b}/icon/desktop` : '';
  }, []);

  const noHeadPreviewUrl = useMemo(() => appendCacheBust(resolveNoHeadAvatarUrl(), cacheBust), [cacheBust]);
  const isNoHeadBroken = Boolean(broken?.['__nohead__']);
  const isUploadingNoHead = uploadingId === '__nohead__';

  const onCreateSkin = async () => {
    const norm = normalizeSkinName(newSkin);
    if (!norm.ok) {
      setErr(norm.error || '皮肤名不合法');
      return;
    }
    setLoading(true);
    setErr('');
    try {
      const res = await createDesktopAssetSkin({ name: norm.value, enabled: true });
      if (!res.success) throw new Error(res.error?.message || '创建皮肤失败');
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e || '创建失败'));
    } finally {
      setLoading(false);
    }
  };

  const onCreateKey = async () => {
    // 自动移除扩展名
    let key = newKey.trim().toLowerCase();
    if (key.includes('.')) {
      key = key.substring(0, key.lastIndexOf('.'));
    }
    
    const norm = normalizeDesktopKey(key);
    if (!norm.ok) {
      setErr(norm.error || 'key 不合法');
      return;
    }
    setLoading(true);
    setErr('');
    try {
      const res = await createDesktopAssetKey({
        key: norm.value,
        kind: newKeyKind,
        description: newKeyDesc.trim() || null,
      });
      if (!res.success) throw new Error(res.error?.message || '创建 key 失败');
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e || '创建失败'));
    } finally {
      setLoading(false);
    }
  };

  const chooseUpload = (skin: string | null, keyRaw: string) => {
    // 自动移除扩展名
    let key = keyRaw.trim().toLowerCase();
    if (key.includes('.')) {
      key = key.substring(0, key.lastIndexOf('.'));
    }
    
    const norm = normalizeDesktopKey(key);
    if (!norm.ok) {
      setErr(norm.error || 'key 不合法');
      return;
    }
    setErr('');
    setUploadTarget({ skin, key: norm.value, mode: 'matrix' });
    const el = fileRef.current;
    if (!el) return;
    // 允许重复选择同名文件也触发 onChange
    el.value = '';
    el.click();
  };

  const chooseNoHeadUpload = () => {
    setErr('');
    setUploadTarget({ skin: null, key: 'nohead.png', mode: 'nohead' });
    const el = fileRef.current;
    if (!el) return;
    el.value = '';
    el.click();
  };

  const onPickedFile = async (file: File | null) => {
    if (!file) return;
    if (!uploadTarget) {
      setErr('未选择上传目标（skin/key）');
      return;
    }
    const mode = uploadTarget.mode || 'matrix';

    if (mode === 'nohead') {
      setUploadingId('__nohead__');
      setErr('');
      try {
        const res = await uploadNoHeadAvatar({ file });
        if (!res.success) throw new Error(res.error?.message || '上传失败');
        setCacheBust(Date.now());
        setBroken((p) => ({ ...(p || {}), __nohead__: false }));
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e || '上传失败'));
      } finally {
        setUploadingId('');
      }
      return;
    }

    const { skin } = uploadTarget;
    const key = uploadTarget.key;

    const id = `${key}@@${skin || '__base__'}`;
    setUploadingId(id);
    setErr('');
    try {
      const res = await uploadDesktopAsset({ skin, key, file });
      if (!res.success) throw new Error(res.error?.message || '上传失败');
      // 触发预览强制刷新（绕过 CDN/浏览器缓存）
      setCacheBust(Date.now());
      // 如果刚上传的是品牌预览 key，清除“预览失败”提示（图标/背景）
      setBroken((p) => {
        const next = { ...p };
        delete next.__branding__;
        delete next.__branding_bg__;
        return next;
      });
      // 上传接口会自动 upsert key 元数据，这里顺手刷新列表
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e || '上传失败'));
    } finally {
      setUploadingId('');
    }
  };

  const handleDeleteKey = async (row: AssetRow) => {
    const keyRaw = String(row.key || '').trim();
    const keyNorm = keyRaw
      .toLowerCase()
      .replace(/^\/+/, '')
      .replace(/\\/g, '')
      .replace(/\//g, '');
    if (!keyNorm) return;

    if (!row.id) {
      setErr(`未找到 key=${keyRaw || keyNorm} 对应的 id，无法删除`);
      return;
    }

    const ok = window.confirm(`确认删除 key：${keyRaw || keyNorm} ？\n将删除此 key 及其下所有文件（所有皮肤）。此操作不可恢复。`);
    if (!ok) return;

    setLoading(true);
    setErr('');
    try {
      const res = await deleteDesktopAssetKey({ id: row.id });
      if (!res.success) throw new Error(res.error?.message || '删除失败');

      // 清理本页“预览失败”标记（避免删除后仍显示红框）
      setBroken((p) => {
        const next = { ...(p || {}) };
        Object.keys(next).forEach((k) => {
          if (k.startsWith(`${keyNorm}@@`)) delete next[k];
        });
        return next;
      });

      // 触发预览强制刷新（绕过 CDN/浏览器缓存）
      setCacheBust(Date.now());

      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e || '删除失败'));
    } finally {
      setLoading(false);
    }
  };

  const hardRefresh = async () => {
    setBroken({});
    setCacheBust(Date.now());
    await reload();
  };

  return (
    <div className="h-full w-full px-6 py-5">
      <input
        ref={fileRef}
        type="file"
        className="hidden"
        onChange={(e) => void onPickedFile(e.target.files?.[0] ?? null)}
      />

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[20px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            资源管理（Desktop / 单文件）
          </div>
          <div className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
            {activeTab === 'desktop' ? (
              <>
                规则固定：<span className="font-mono">/icon/desktop/&lt;skin?&gt;/&lt;key&gt;</span>；悬浮可见源站地址；优先皮肤专有资源，不存在则回落默认。
              </>
            ) : (
              <>
                单文件资源不区分皮肤：用于全局兜底（例如无头像 nohead.png）。
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {activeTab === 'desktop' ? (
            <button
              type="button"
              className={cn('rounded-[12px] px-3 py-2 text-sm border border-white/10 hover:bg-white/5', loading && 'opacity-60 pointer-events-none')}
              onClick={() => void reload()}
              title="重新获取 skins/keys"
            >
              重新获取皮肤
            </button>
          ) : null}
          <button
            type="button"
            className={cn('rounded-[12px] px-3 py-2 text-sm border border-white/10 hover:bg-white/5', loading && 'opacity-60 pointer-events-none')}
            onClick={() => void hardRefresh()}
            title="清空本页缓存（缺失标记 + 预览缓存）并重新获取"
          >
            清空缓存并刷新
          </button>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setActiveTab('desktop')}
          className={cn(
            'h-9 px-3 rounded-[12px] border text-sm',
            activeTab === 'desktop' ? 'border-white/20 bg-white/5' : 'border-white/10 hover:bg-white/5'
          )}
        >
          Desktop 资源矩阵（皮肤）
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('single')}
          className={cn(
            'h-9 px-3 rounded-[12px] border text-sm',
            activeTab === 'single' ? 'border-white/20 bg-white/5' : 'border-white/10 hover:bg-white/5'
          )}
        >
          单文件资源（不分皮肤）
        </button>
      </div>

      {err ? (
        <div
          className="mt-4 rounded-[12px] px-4 py-3 text-sm"
          style={{
            background: 'color-mix(in srgb, #ff4d4f 10%, transparent)',
            border: '1px solid color-mix(in srgb, #ff4d4f 35%, var(--border-subtle))',
            color: 'var(--text-primary)',
          }}
        >
          {err}
        </div>
      ) : null}

      {activeTab === 'single' ? (
        <div className="mt-4 rounded-[16px] p-4" style={{ background: 'var(--panel, var(--bg-elevated))', border: '1px solid var(--border-subtle)' }}>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                无头像兜底（required）：nohead.png
              </div>
              <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                固定路径：<span className="font-mono">/icon/backups/head/nohead.png</span>（不分白天/黑夜；仅此一个文件）。
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                className={cn('h-9 px-3 rounded-[12px] border border-white/10 hover:bg-white/5 text-sm', isUploadingNoHead && 'opacity-60 pointer-events-none')}
                onClick={() => chooseNoHeadUpload()}
              >
                {isUploadingNoHead ? '上传中...' : '上传/替换'}
              </button>
              <button
                type="button"
                className="h-9 px-3 rounded-[12px] border border-white/10 hover:bg-white/5 text-sm"
                onClick={() => void copyText(noHeadPreviewUrl)}
                disabled={!noHeadPreviewUrl}
              >
                复制地址
              </button>
              <button
                type="button"
                className="h-9 px-3 rounded-[12px] border border-white/10 hover:bg-white/5 text-sm"
                onClick={() => window.open(noHeadPreviewUrl, '_blank', 'noopener,noreferrer')}
                disabled={!noHeadPreviewUrl}
              >
                查看
              </button>
            </div>
          </div>

          <div className="mt-3 flex items-start gap-4">
            <div
              className={cn('rounded-[12px] border p-2', isNoHeadBroken ? 'border-red-500/40' : 'border-white/10')}
              style={{ width: '120px', height: '120px', background: isNoHeadBroken ? 'rgba(239,68,68,0.08)' : 'rgba(255,255,255,0.02)' }}
              title={noHeadPreviewUrl || ''}
            >
              {noHeadPreviewUrl ? (
                <img
                  src={noHeadPreviewUrl}
                  alt=""
                  className="w-full h-full object-contain"
                  onError={() => setBroken((m) => ({ ...(m || {}), __nohead__: true }))}
                  onLoad={() => setBroken((m) => ({ ...(m || {}), __nohead__: false }))}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-xs" style={{ color: 'var(--text-muted)' }}>
                  无 URL
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                当前地址
              </div>
              <div className="mt-1 font-mono text-sm break-all" style={{ color: 'var(--text-primary)' }}>
                {noHeadPreviewUrl || '-'}
              </div>
              {isNoHeadBroken ? (
                <div className="mt-2 text-xs" style={{ color: 'var(--danger, #ef4444)' }}>
                  缺失/不可用：请上传 nohead.png
                </div>
              ) : (
                <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                  建议尺寸：128x128 或更大；支持 png（推荐带透明通道）。
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {activeTab === 'desktop' ? (
        <>
      <div className="mt-4 rounded-[16px] p-4" style={{ background: 'var(--panel, var(--bg-elevated))', border: '1px solid var(--border-subtle)' }}>
        <div className="flex flex-wrap items-end gap-3 justify-between">
          <div className="min-w-0">
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              资源根目录
            </div>
            <div className="mt-1 font-mono text-sm break-all" style={{ color: 'var(--text-primary)' }}>
              {desktopRoot || '-'}
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div>
              <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
                新建皮肤（仅小写）
              </div>
              <div className="flex items-center gap-2">
                <input
                  value={newSkin}
                  onChange={(e) => setNewSkin(e.target.value)}
                  className="h-9 px-3 rounded-[12px] bg-black/15 border border-white/10 text-sm w-[160px]"
                  placeholder="white / dark / blue"
                />
                <button
                  type="button"
                  className={cn('h-9 px-3 rounded-[12px] border border-white/10 hover:bg-white/5 text-sm', loading && 'opacity-60 pointer-events-none')}
                  onClick={() => void onCreateSkin()}
                >
                  新建皮肤
                </button>
              </div>
            </div>

            <div>
              <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
                新建 key（仅文件名）
              </div>
              <div className="flex items-center gap-2">
                <input
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  className="h-9 px-3 rounded-[12px] bg-black/15 border border-white/10 text-sm w-[220px]"
                  placeholder="例如 load（不含扩展名）"
                />
                <select
                  value={newKeyKind}
                  onChange={(e) => setNewKeyKind(e.target.value as AssetKind)}
                  className="h-9 px-3 rounded-[12px] bg-black/15 border border-white/10 text-sm"
                >
                  <option value="image">image</option>
                  <option value="audio">audio</option>
                  <option value="video">video</option>
                  <option value="other">other</option>
                </select>
                <input
                  value={newKeyDesc}
                  onChange={(e) => setNewKeyDesc(e.target.value)}
                  className="h-9 px-3 rounded-[12px] bg-black/15 border border-white/10 text-sm w-[220px]"
                  placeholder="描述（可选）"
                />
                <button
                  type="button"
                  className={cn('h-9 px-3 rounded-[12px] border border-white/10 hover:bg-white/5 text-sm', loading && 'opacity-60 pointer-events-none')}
                  onClick={() => void onCreateKey()}
                >
                  新建 key
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Desktop 品牌配置（放在资源管理之后） */}
      <div
        className="mt-4 rounded-[16px] p-4"
        style={{ background: 'var(--panel, var(--bg-elevated))', border: '1px solid var(--border-subtle)' }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              Desktop 品牌配置（登录页名称 + 图标 + 背景图）
            </div>
            <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
              在线模式下 Desktop 会拉取该配置：名称用于登录页标题；图标/背景图从 <span className="font-mono">/icon/desktop/&lt;key&gt;</span> 加载（key 仅文件名、必须全小写，可指向任意图片格式；背景图允许为空表示使用内置背景）。
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              className="px-3 py-2 text-sm rounded-xl ui-control hover:opacity-90"
              onClick={() => void saveBranding()}
              disabled={brandingSaving}
              title="保存 Desktop 品牌配置"
              type="button"
            >
              {brandingSaving ? '保存中...' : '保存'}
            </button>
          </div>
        </div>

        {/* 三个文本 */}
        <div className="mt-3 grid grid-cols-3 gap-4">
          <div>
            <div className="text-xs mb-2 font-medium" style={{ color: 'var(--text-muted)' }}>大标题</div>
            <input
              className="w-full px-3 py-2 rounded-xl ui-control"
              value={brandingName}
              onChange={(e) => setBrandingName(e.target.value)}
              placeholder="PRD Agent"
            />
          </div>

          <div>
            <div className="text-xs mb-2 font-medium" style={{ color: 'var(--text-muted)' }}>小标题</div>
            <input
              className="w-full px-3 py-2 rounded-xl ui-control"
              value={brandingSubtitle}
              onChange={(e) => setBrandingSubtitle(e.target.value)}
              placeholder="智能PRD解读助手"
            />
          </div>

          <div>
            <div className="text-xs mb-2 font-medium" style={{ color: 'var(--text-muted)' }}>窗口标题（title）</div>
            <input
              className="w-full px-3 py-2 rounded-xl ui-control"
              value={brandingWindowTitle}
              onChange={(e) => setBrandingWindowTitle(e.target.value)}
              placeholder="PRD Agent"
            />
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-[16px] p-4" style={{ background: 'var(--panel, var(--bg-elevated))', border: '1px solid var(--border-subtle)' }}>
        <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          资源诊断矩阵（含缺失展示；支持上传覆盖写）
        </div>
        <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          说明：本页 key 对齐 Desktop 端规则，仅支持文件名（不支持子目录）。上传会覆盖写到 COS：<span className="font-mono">icon/desktop/&lt;skin?&gt;/&lt;key&gt;</span>（全小写）。
        </div>

        <div className="mt-3 overflow-auto">
          <div
            className="grid"
            style={{
              gridTemplateColumns: `180px repeat(${columns.length}, minmax(240px, 1fr))`,
            }}
          >
            {/* 表头 */}
            <div
              className="sticky top-0 z-10 px-3 py-2 text-sm"
              style={{ background: 'var(--panel-solid, var(--bg-elevated))', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}
            >
              项目
            </div>
            {columns.map((c) => (
              <div
                key={c}
                className="sticky top-0 z-10 px-3 py-2 text-sm font-semibold"
                style={{ background: 'var(--panel-solid, var(--bg-elevated))', color: 'var(--text-primary)', borderBottom: '1px solid var(--border-subtle)' }}
              >
                {c === '__base__' ? '默认' : labelForSkin(c)}
              </div>
            ))}

            {rows.map((row) => (
              <RowBlock
                key={row.key}
                row={row}
                columns={columns}
                broken={broken}
                uploadingId={uploadingId}
                matrixData={matrixData}
                onBroken={(id) => setBroken((m) => ({ ...(m || {}), [id]: true }))}
                onRecovered={(id) => setBroken((m) => ({ ...(m || {}), [id]: false }))}
                onUpload={(skin, key) => chooseUpload(skin, key)}
                onDelete={() => void handleDeleteKey(row)}
              />
            ))}
            {rows.length === 0 ? (
              <div className="py-3" style={{ color: 'var(--text-muted)' }}>
                暂无 key
              </div>
            ) : null}
          </div>
        </div>
      </div>
        </>
      ) : null}
    </div>
  );
}

function RowBlock(props: {
  row: AssetRow;
  columns: string[];
  broken: Record<string, boolean>;
  uploadingId: string;
  matrixData: AdminDesktopAssetMatrixRow[];
  onBroken: (id: string) => void;
  onRecovered: (id: string) => void;
  onUpload: (skin: string | null, key: string) => void;
  onDelete: () => void;
}) {
  const { row, columns, broken, uploadingId, matrixData, onBroken, onRecovered, onUpload, onDelete } = props;
  const BOX = 96;

  // 从 matrixData 中查找当前 row 的 description
  const matrixRow = matrixData.find(m => m.key === row.key);
  const displayTitle = matrixRow?.description || row.title;

  return (
    <>
      <div className="px-3 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex flex-col gap-2">
          <div className="text-sm font-semibold break-all" style={{ color: 'var(--text-primary)' }}>
            {displayTitle}
          </div>
          {!row.required && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onDelete}
                className="text-[10px] px-2 py-0.5 rounded border border-red-500/20 text-red-400 hover:bg-red-500/10"
                title="删除此 Key 及其下所有文件"
              >
                删除
              </button>
            </div>
          )}
        </div>
        <div className="mt-1 text-xs font-mono break-all" style={{ color: 'var(--text-muted)' }}>
          {row.key}
          {row.required ? <span style={{ color: 'var(--accent-gold)' }}>（required）</span> : null}
        </div>
      </div>

      {columns.map((c) => {
        const skin = c === '__base__' ? null : c;
        const skinKey = c === '__base__' ? '' : c;
        
        // 从 matrixData 中查找对应的单元格数据
        const matrixRow = matrixData.find(m => m.key === row.key);
        const cell = matrixRow?.cells?.[skinKey];
        const url = cell?.url || '';
        const isFallback = cell?.isFallback ?? false;
        
        const id = `${row.key}@@${c}`;
        const isBroken = !url || Boolean(broken?.[id]);
        const isUploading = uploadingId === `${row.key}@@${skin || '__base__'}`;
        
        // 从 URL 中提取文件名（含扩展名）
        const fileName = url ? url.split('/').pop()?.split('?')[0] || row.key : row.key;
        
        // 判断是否为视频文件
        const isVideo = fileName.toLowerCase().endsWith('.mp4') || 
                       fileName.toLowerCase().endsWith('.webm') || 
                       fileName.toLowerCase().endsWith('.mov');

        return (
          <div key={id} className="px-3 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <div className="flex flex-col gap-2">
              <div
                className={cn(
                  'rounded-[12px] border p-2',
                  isBroken ? 'border-red-500/40' : (isFallback ? 'border-yellow-500/40 border-dashed' : 'border-white/10')
                )}
                style={{ width: `${BOX}px`, height: `${BOX}px`, background: isBroken ? 'rgba(239,68,68,0.08)' : (isFallback ? 'rgba(234,179,8,0.05)' : 'rgba(255,255,255,0.02)') }}
                title={url || '未上传'}
              >
                {url ? (
                  isVideo ? (
                    <video
                      src={url}
                      className="block w-full h-full select-none pointer-events-none"
                      style={{ objectFit: 'contain' }}
                      muted
                      loop
                      autoPlay
                      playsInline
                      onError={() => onBroken(id)}
                      onLoadedData={() => onRecovered(id)}
                    />
                  ) : (
                    <img
                      src={url}
                      alt=""
                      className="block w-full h-full select-none pointer-events-none"
                      style={{ objectFit: 'contain' }}
                      onError={() => onBroken(id)}
                      onLoad={() => onRecovered(id)}
                    />
                  )
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-xs" style={{ color: 'var(--text-muted)' }}>
                    未上传
                  </div>
                )}
              </div>

              <div className="text-xs" style={{ color: isBroken ? 'rgba(248,113,113,0.95)' : (isFallback ? 'rgba(234,179,8,0.85)' : 'var(--text-muted)') }}>
                {isBroken ? '缺失/不可用' : (isFallback ? '回退' : '正常')}
              </div>
              <div className="text-xs font-mono break-all flex items-center gap-1" style={{ color: 'var(--text-muted)' }} title={url || ''}>
                <span>{fileName}</span>
                {skin && <span className="text-[10px] px-1 py-0.5 rounded" style={{ background: 'var(--border-subtle)', color: 'var(--text-muted)' }}>{skin}</span>}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className={cn('px-2 py-1 rounded-[10px] border border-white/10 hover:bg-white/5 text-xs', isUploading && 'opacity-60 pointer-events-none')}
                  onClick={() => onUpload(skin, row.key)}
                  title="上传/替换（覆盖写）"
                >
                  {isUploading ? '上传中...' : '上传/替换'}
                </button>
                <button
                  type="button"
                  className="px-2 py-1 rounded-[10px] border border-white/10 hover:bg-white/5 text-xs"
                  onClick={() => void copyText(url)}
                  title="复制源站地址"
                >
                  复制地址
                </button>
                <a className="text-xs underline" href={url} target="_blank" rel="noreferrer">
                  查看
                </a>
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}


