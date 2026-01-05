import { useEffect, useMemo, useRef, useState } from 'react';
import { createDesktopAssetKey, createDesktopAssetSkin, getDesktopBrandingSettings, listDesktopAssetKeys, listDesktopAssetSkins, updateDesktopBrandingSettings, uploadDesktopAsset } from '@/services';
import type { DesktopAssetKey, DesktopAssetSkin } from '@/services/contracts/desktopAssets';

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(' ');
}

type AssetKind = 'image' | 'audio' | 'video' | 'other';

type AssetRow = {
  title: string;
  key: string;
  kind: AssetKind;
  description?: string | null;
  required?: boolean;
};

// 诊断页固定要求的资源（仅保留“启动/加载”这类真正刚需；登录图标由品牌配置 loginIconKey 决定）
const REQUIRED_ASSETS: AssetRow[] = [
  { title: '冷启动加载', key: 'start_load.gif', kind: 'image', required: true },
  { title: '加载动画', key: 'load.gif', kind: 'image', required: true },
];

// 有“品牌配置”后，这两个 key 的单独行展示会显得重复（仍可通过品牌配置上传/或手动新建 key 上传）
import { getAvatarBaseUrl } from '@/lib/avatar';

const HIDDEN_ASSET_KEYS = new Set(['login_icon.png', 'login_logo.svg']);

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

function buildIconUrl(baseUrl: string, key: string, skin?: string | null, cacheBust?: number | null): string {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '');
  const k = String(key || '').trim().replace(/^\/+/, '');
  const s = String(skin || '').trim().replace(/^\/+|\/+$/g, '');
  if (!b || !k) return '';
  const url = s ? `${b}/icon/desktop/${s}/${k}` : `${b}/icon/desktop/${k}`;
  const v = typeof cacheBust === 'number' && Number.isFinite(cacheBust) ? String(Math.floor(cacheBust)) : '';
  return v ? `${url}?v=${encodeURIComponent(v)}` : url;
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
  const [skins, setSkins] = useState<DesktopAssetSkin[]>([]);
  const [keys, setKeys] = useState<DesktopAssetKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const [brandingName, setBrandingName] = useState('PRD Agent');
  const [brandingIconKey, setBrandingIconKey] = useState('login_icon.png');
  const [brandingBgKey, setBrandingBgKey] = useState('');
  const [brandingSaving, setBrandingSaving] = useState(false);

  const [cacheBust, setCacheBust] = useState<number>(() => Date.now());
  const [broken, setBroken] = useState<Record<string, boolean>>({});

  const [newSkin, setNewSkin] = useState('white');
  const [newKey, setNewKey] = useState('load.gif');
  const [newKeyKind, setNewKeyKind] = useState<AssetKind>('image');
  const [newKeyDesc, setNewKeyDesc] = useState('');

  const [uploadingId, setUploadingId] = useState<string>('');
  const [uploadTarget, setUploadTarget] = useState<{ skin: string | null; key: string; mode?: 'matrix' | 'branding_icon' | 'branding_bg' } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const reload = async () => {
    setLoading(true);
    setErr('');
    try {
      const [sRes, kRes, bRes] = await Promise.all([listDesktopAssetSkins(), listDesktopAssetKeys(), getDesktopBrandingSettings()]);
      if (!sRes.success) throw new Error(sRes.error?.message || '加载 skins 失败');
      if (!kRes.success) throw new Error(kRes.error?.message || '加载 keys 失败');
      setSkins(Array.isArray(sRes.data) ? sRes.data : []);
      setKeys(Array.isArray(kRes.data) ? kRes.data : []);
      if (bRes.success && bRes.data) {
        setBrandingName(String(bRes.data.desktopName || 'PRD Agent'));
        setBrandingIconKey(String(bRes.data.loginIconKey || 'login_icon.png'));
        setBrandingBgKey(String(bRes.data.loginBackgroundKey || ''));
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

  const brandingPreviewUrl = useMemo(() => {
    const k = String(brandingIconKey || '').trim().toLowerCase().replace(/^\/+/, '').replace(/\\/g, '').replace(/\//g, '');
    return buildIconUrl(getBaseAssetsUrl(), k || 'login_icon.png', null, cacheBust);
  }, [brandingIconKey, cacheBust]);

  const brandingBgPreviewUrl = useMemo(() => {
    const k = String(brandingBgKey || '').trim().toLowerCase().replace(/^\/+/, '').replace(/\\/g, '').replace(/\//g, '');
    return k ? buildIconUrl(getBaseAssetsUrl(), k, null, cacheBust) : '';
  }, [brandingBgKey, cacheBust]);

  const saveBranding = async () => {
    setBrandingSaving(true);
    setErr('');
    try {
      const name = String(brandingName || '').trim();
      const key = String(brandingIconKey || '').trim().toLowerCase().replace(/^\/+/, '').replace(/\\/g, '').replace(/\//g, '');
      const bgKey = String(brandingBgKey || '').trim().toLowerCase().replace(/^\/+/, '').replace(/\\/g, '').replace(/\//g, '');
      const res = await updateDesktopBrandingSettings({
        desktopName: name || 'PRD Agent',
        loginIconKey: key || 'login_icon.png',
        loginBackgroundKey: bgKey || '',
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
    const requiredMap = new Map(REQUIRED_ASSETS.map((r) => [r.key, r]));
    const extra: AssetRow[] = (Array.isArray(keys) ? keys : [])
      .map((k) => ({
        title: (k.description || '').trim() || k.key,
        key: k.key,
        kind: (k.kind as AssetKind) || 'image',
        description: k.description ?? null,
        required: requiredMap.has(k.key),
      }))
      .filter((r) => !requiredMap.has(r.key))
      .filter((r) => !HIDDEN_ASSET_KEYS.has(String(r.key || '').trim().toLowerCase()));
    return [...REQUIRED_ASSETS, ...extra];
  }, [keys]);

  const desktopRoot = useMemo(() => {
    const b = String(getBaseAssetsUrl() || '').trim().replace(/\/+$/, '');
    return b ? `${b}/icon/desktop` : '';
  }, []);

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
    const norm = normalizeDesktopKey(newKey);
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
    const norm = normalizeDesktopKey(keyRaw);
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

  const onPickedFile = async (file: File | null) => {
    if (!file) return;
    if (!uploadTarget) {
      setErr('未选择上传目标（skin/key）');
      return;
    }
    const { skin, mode } = uploadTarget;
    let key = uploadTarget.key;

    // 品牌配置：登录图标 key 不允许手填，自动取上传文件名作为 key（并强制全小写/仅文件名）
    if (mode === 'branding_icon') {
      const norm = normalizeDesktopKey(file.name);
      if (!norm.ok) {
        setErr(norm.error || '登录图标文件名不合法（将作为 key 使用）');
        return;
      }
      key = norm.value;
      setBrandingIconKey(norm.value);
    }

    // 品牌配置：背景图允许手填，但上传时也做一次兜底规范化（若为空则按文件名）
    if (mode === 'branding_bg') {
      const raw = String(brandingBgKey || '').trim();
      const norm = normalizeDesktopKey(raw || file.name);
      if (!norm.ok) {
        setErr(norm.error || '背景图 key/文件名不合法');
        return;
      }
      key = norm.value;
      setBrandingBgKey(norm.value);
    }

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

  const chooseBrandingIconUpload = () => {
    setErr('');
    setUploadTarget({ skin: null, key: '', mode: 'branding_icon' });
    const el = fileRef.current;
    if (!el) return;
    el.value = '';
    el.click();
  };

  const chooseBrandingBgUpload = () => {
    const raw = String(brandingBgKey || '').trim();
    setErr('');
    // 允许为空：为空则上传时使用文件名作为 key
    setUploadTarget({ skin: null, key: raw, mode: 'branding_bg' });
    const el = fileRef.current;
    if (!el) return;
    el.value = '';
    el.click();
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
            Desktop 资源管理（诊断 + 上传）
          </div>
          <div className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
            规则固定：<span className="font-mono">/icon/desktop/&lt;skin?&gt;/&lt;key&gt;</span>；悬浮可见源站地址；优先皮肤专有资源，不存在则回落默认。
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            className={cn('rounded-[12px] px-3 py-2 text-sm border border-white/10 hover:bg-white/5', loading && 'opacity-60 pointer-events-none')}
            onClick={() => void reload()}
            title="重新获取 skins/keys"
          >
            重新获取皮肤
          </button>
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
                  placeholder="例如 load.gif"
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
              className={cn(
                'px-3 py-2 text-sm rounded-xl ui-control hover:opacity-90',
                uploadingId === `${String(brandingIconKey || '').trim().toLowerCase().replace(/^\/+/, '').replace(/\\/g, '').replace(/\//g, '') || 'login_icon.png'}@@__base__` &&
                  'opacity-60 pointer-events-none'
              )}
              onClick={() => chooseBrandingIconUpload()}
              title="上传当前登录图标 key 对应的文件到 /icon/desktop/<key>"
              type="button"
            >
              上传图标
            </button>
            <button
              className={cn(
                'px-3 py-2 text-sm rounded-xl ui-control hover:opacity-90',
                uploadingId === `${String(brandingBgKey || '').trim().toLowerCase().replace(/^\/+/, '').replace(/\\/g, '').replace(/\//g, '')}@@__base__` &&
                  'opacity-60 pointer-events-none'
              )}
              onClick={() => chooseBrandingBgUpload()}
              title="上传当前背景图 key 对应的文件到 /icon/desktop/<key>"
              type="button"
            >
              上传背景
            </button>
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

        <div className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="md:col-span-1">
            <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Desktop 名称</div>
            <input
              className="w-full px-3 py-2 rounded-xl ui-control"
              value={brandingName}
              onChange={(e) => setBrandingName(e.target.value)}
              placeholder="PRD Agent"
            />
          </div>
          <div className="md:col-span-1">
            <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>登录图标 key（文件名，自动）</div>
            <div className="w-full px-3 py-2 rounded-xl ui-control font-mono flex items-center justify-between gap-2">
              <span className="truncate">{brandingIconKey || '（未生成）'}</span>
              <button
                type="button"
                className="px-2 py-1 rounded-[10px] border border-white/10 hover:bg-white/5 text-xs shrink-0"
                onClick={() => void copyText(brandingIconKey)}
                title="复制 key"
              >
                复制
              </button>
            </div>
            <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              说明：点击“上传图标”后，会自动使用上传文件名作为 key（仅文件名、自动转全小写）。
            </div>
          </div>
          <div className="md:col-span-1">
            <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>背景图 key（文件名，可空）</div>
            <input
              className="w-full px-3 py-2 rounded-xl ui-control font-mono"
              value={brandingBgKey}
              onChange={(e) => setBrandingBgKey(e.target.value)}
              placeholder="例如 login_bg.png（可留空）"
            />
          </div>
          <div className="md:col-span-1">
            <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>预览（base）</div>
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-3">
                <img
                  src={brandingPreviewUrl}
                  alt="login icon preview"
                  className="h-10 w-10 rounded-xl border"
                  style={{ borderColor: 'var(--border-subtle)' }}
                  onError={() => setBroken((p) => ({ ...p, __branding__: true }))}
                />
                <div className="min-w-0">
                  <div className="text-xs font-mono break-all" style={{ color: 'var(--text-muted)' }}>
                    {brandingPreviewUrl}
                  </div>
                </div>
              </div>

              {brandingBgPreviewUrl ? (
                <div className="flex items-center gap-3">
                  <img
                    src={brandingBgPreviewUrl}
                    alt="login background preview"
                    className="h-10 w-[80px] rounded-xl border"
                    style={{ borderColor: 'var(--border-subtle)', objectFit: 'cover' }}
                    onError={() => setBroken((p) => ({ ...p, __branding_bg__: true }))}
                  />
                  <div className="min-w-0">
                    <div className="text-xs font-mono break-all" style={{ color: 'var(--text-muted)' }}>
                      {brandingBgPreviewUrl}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  背景图未配置：使用内置背景
                </div>
              )}
            </div>

            {broken.__branding__ ? (
              <div className="mt-1 text-xs" style={{ color: 'var(--danger, #ef4444)' }}>
                图标预览加载失败：请确认该 key 已在本页上传（或已存在于 COS）。
              </div>
            ) : null}
            {broken.__branding_bg__ ? (
              <div className="mt-1 text-xs" style={{ color: 'var(--danger, #ef4444)' }}>
                背景预览加载失败：请确认该 key 已在本页上传（或已存在于 COS）。
              </div>
            ) : null}
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
                cacheBust={cacheBust}
                broken={broken}
                uploadingId={uploadingId}
                onBroken={(id) => setBroken((m) => ({ ...(m || {}), [id]: true }))}
                onRecovered={(id) => setBroken((m) => ({ ...(m || {}), [id]: false }))}
                onUpload={(skin, key) => chooseUpload(skin, key)}
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
    </div>
  );
}

function RowBlock(props: {
  row: AssetRow;
  columns: string[];
  cacheBust: number;
  broken: Record<string, boolean>;
  uploadingId: string;
  onBroken: (id: string) => void;
  onRecovered: (id: string) => void;
  onUpload: (skin: string | null, key: string) => void;
}) {
  const { row, columns, cacheBust, broken, uploadingId, onBroken, onRecovered, onUpload } = props;
  const BOX = 96;

  return (
    <>
      <div className="px-3 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          {row.title}
        </div>
        <div className="mt-1 text-xs font-mono break-all" style={{ color: 'var(--text-muted)' }}>
          {row.key}
          {row.required ? <span style={{ color: 'var(--accent-gold)' }}>（required）</span> : null}
        </div>
      </div>

      {columns.map((c) => {
        const skin = c === '__base__' ? null : c;
        const url = buildIconUrl(getBaseAssetsUrl(), row.key, skin, cacheBust);
        const relPath = `${skin ? `${skin}/` : ''}${row.key}`;
        const id = `${row.key}@@${c}`;
        const isBroken = Boolean(broken?.[id]);
        const isUploading = uploadingId === `${row.key}@@${skin || '__base__'}`;

        return (
          <div key={id} className="px-3 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <div className="flex flex-col gap-2">
              <div
                className={cn(
                  'rounded-[12px] border p-2',
                  isBroken ? 'border-red-500/40' : 'border-white/10'
                )}
                style={{ width: `${BOX}px`, height: `${BOX}px`, background: isBroken ? 'rgba(239,68,68,0.08)' : 'rgba(255,255,255,0.02)' }}
                title={url || ''}
              >
                {url ? (
                  <img
                    src={url}
                    alt=""
                    className="block w-full h-full select-none pointer-events-none"
                    style={{ objectFit: 'contain' }}
                    onError={() => onBroken(id)}
                    onLoad={() => onRecovered(id)}
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-xs" style={{ color: 'var(--text-muted)' }}>
                    无 URL
                  </div>
                )}
              </div>

              <div className="text-xs" style={{ color: isBroken ? 'rgba(248,113,113,0.95)' : 'var(--text-muted)' }}>
                {isBroken ? '缺失/不可用' : '正常'}
              </div>
              <div className="text-xs font-mono break-all" style={{ color: 'var(--text-muted)' }} title={url || ''}>
                {relPath}
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


