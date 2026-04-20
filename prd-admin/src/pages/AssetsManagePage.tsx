import { useEffect, useMemo, useRef, useState } from 'react';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import {
  createDesktopAssetKey,
  createDesktopAssetSkin,
  deleteDesktopAssetKey,
  getDesktopBrandingSettings,
  getDesktopAssetsMatrix,
  listDesktopAssetSkins,
  updateDesktopBrandingSettings,
  uploadDesktopAsset,
  uploadNoHeadAvatar,
  listHomepageAssets,
  uploadHomepageAsset,
  deleteHomepageAsset,
} from '@/services';
import type { AdminDesktopAssetMatrixRow, DesktopAssetSkin } from '@/services/contracts/desktopAssets';
import type { HomepageAssetDto } from '@/services/contracts/homepageAssets';
import { GlassCard } from '@/components/design/GlassCard';
import { TabBar } from '@/components/design/TabBar';
import { Select } from '@/components/design/Select';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import {
  FolderOpen,
  Home,
  Image,
  Layers,
  Monitor,
  Palette,
  PanelTop,
  Plus,
  Save,
  Sparkles,
  Store,
  Trash2,
  Upload,
  User,
  Video as VideoIcon,
} from 'lucide-react';
import {
  HOMEPAGE_CARD_SLOTS,
  HOMEPAGE_AGENT_SLOTS,
  HOMEPAGE_HERO_SLOTS,
  MARKETPLACE_BG_SLOTS,
  buildDefaultCoverUrl,
  buildDefaultVideoUrl,
  buildDefaultHeroUrl,
  type HomepageCardSlot,
  type HomepageAgentSlot,
  type HomepageHeroSlot,
  type MarketplaceBgSlot,
} from '@/lib/homepageAssetSlots';
import { useToolboxStore, BUILTIN_TOOLS } from '@/stores/toolboxStore';
import { useHomepageAssetsStore } from '@/stores/homepageAssetsStore';
import { useAuthStore } from '@/stores/authStore';

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
const USED_ASSET_KEYS = new Set<string>(['load', 'start_load', 'login_icon']);

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
  return getAvatarBaseUrl();
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

// 输入框组件
function InputField({
  label,
  value,
  onChange,
  placeholder,
  className,
  mono,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  mono?: boolean;
}) {
  return (
    <div className={className}>
      {label && (
        <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
          {label}
        </label>
      )}
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          'w-full h-10 px-3 rounded-xl text-sm transition-all duration-200',
          'focus:outline-none focus:ring-2 focus:ring-[var(--accent-gold)]/30',
          mono && 'font-mono'
        )}
        style={{
          background: 'var(--bg-input)',
          border: '1px solid var(--border-subtle)',
          color: 'var(--text-primary)',
        }}
      />
    </div>
  );
}

// 选择框组件
function SelectField({
  label,
  value,
  onChange,
  options,
  className,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  className?: string;
}) {
  return (
    <div className={className}>
      {label && (
        <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
          {label}
        </label>
      )}
      <Select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        uiSize="md"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

// 区块标题组件
function SectionTitle({ icon, title, badge }: { icon: React.ReactNode; title: string; badge?: string }) {
  return (
    <div className="flex items-center gap-2">
      <span style={{ color: 'var(--accent-gold)' }}>{icon}</span>
      <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
        {title}
      </span>
      {badge && (
        <Badge variant="subtle" size="sm">
          {badge}
        </Badge>
      )}
    </div>
  );
}

type HomepageAssetsMap = Record<string, HomepageAssetDto>;

export default function AssetsManagePage() {
  const { isMobile } = useBreakpoint();
  const [activeTab, setActiveTab] = useState<'desktop' | 'single' | 'homepage' | 'marketplace'>('homepage'); // 默认落到新的首页资源 Tab，便于用户直接看到新功能
  const [skins, setSkins] = useState<DesktopAssetSkin[]>([]);
  const [matrixData, setMatrixData] = useState<AdminDesktopAssetMatrixRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  // 首页资源（卡片背景 + Agent 封面图/视频）
  const [homepageAssets, setHomepageAssets] = useState<HomepageAssetsMap>({});
  const [homepageLoading, setHomepageLoading] = useState(false);
  const [homepageCacheBust, setHomepageCacheBust] = useState<number>(() => Date.now());

  // 动态 Agent 列表：BUILTIN_TOOLS + 用户自建工具箱条目（toolboxStore.items）。
  // 新增 Agent 自动进入上传界面，无需手动在 HOMEPAGE_AGENT_SLOTS 里登记。
  const toolboxItems = useToolboxStore((s) => s.items);
  const loadToolboxItems = useToolboxStore((s) => s.loadItems);
  useEffect(() => {
    if (activeTab === 'homepage' && toolboxItems.length === 0) {
      void loadToolboxItems();
    }
  }, [activeTab, toolboxItems.length, loadToolboxItems]);

  const agentSlotList: HomepageAgentSlot[] = useMemo(() => {
    const meta = new Map<string, HomepageAgentSlot>();
    // 1) 预设清单（保证顺序和展示名）
    HOMEPAGE_AGENT_SLOTS.forEach((s) => meta.set(s.agentKey, { ...s }));
    // 2) BUILTIN_TOOLS：新增内置 Agent（未登记在 HOMEPAGE_AGENT_SLOTS 时补齐）
    BUILTIN_TOOLS.forEach((t) => {
      const key = String(t.agentKey || '').trim();
      if (!key || meta.has(key)) return;
      meta.set(key, { agentKey: key, label: t.name, description: t.description });
    });
    // 3) 工具箱自建条目（含 agentKey）：用户自定义的 Agent
    toolboxItems.forEach((t) => {
      const key = String(t.agentKey || '').trim();
      if (!key || meta.has(key)) return;
      meta.set(key, { agentKey: key, label: t.name, description: t.description });
    });
    // 4) 已上传但本地清单里找不到的 orphan slot（被删除的 Agent 或老残留）→ 也显示，让用户能清理
    Object.keys(homepageAssets).forEach((slot) => {
      const m = /^agent\.(.+)\.(image|video)$/.exec(slot);
      if (!m) return;
      const key = m[1];
      if (!meta.has(key)) meta.set(key, { agentKey: key, label: `(未知 Agent) ${key}`, description: 'slot 记录已存在但未在当前 Agent 清单中' });
    });
    return Array.from(meta.values());
  }, [toolboxItems, homepageAssets]);

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
  const [uploadTarget, setUploadTarget] = useState<
    | { skin: string | null; key: string; mode: 'matrix' }
    | { skin: null; key: string; mode: 'nohead' }
    | { mode: 'homepage'; slot: string }
    | null
  >(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const homepageFileRef = useRef<HTMLInputElement | null>(null);

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

  const reloadHomepage = async () => {
    setHomepageLoading(true);
    try {
      const res = await listHomepageAssets();
      if (!res.success) {
        setErr(res.error?.message || '加载首页资源失败');
        return;
      }
      const map: HomepageAssetsMap = {};
      (Array.isArray(res.data) ? res.data : []).forEach((item) => {
        if (item?.slot) map[item.slot] = item;
      });
      setHomepageAssets(map);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e || '加载失败'));
    } finally {
      setHomepageLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'homepage' || activeTab === 'marketplace') {
      void reloadHomepage();
    }
  }, [activeTab]);

  const chooseHomepageUpload = (slot: string, accept?: string) => {
    setErr('');
    setUploadTarget({ mode: 'homepage', slot });
    const el = homepageFileRef.current;
    if (!el) return;
    el.value = '';
    el.accept = accept || 'image/*,video/mp4,video/webm,video/quicktime';
    el.click();
  };

  const onPickedHomepageFile = async (file: File | null) => {
    if (!file) return;
    if (!uploadTarget || uploadTarget.mode !== 'homepage') {
      setErr('未选择首页资源上传目标');
      return;
    }
    const { slot } = uploadTarget;
    setUploadingId(`homepage::${slot}`);
    setErr('');
    try {
      const res = await uploadHomepageAsset({ slot, file });
      if (!res.success || !res.data) throw new Error(res.error?.message || '上传失败');
      setHomepageAssets((prev) => ({ ...prev, [slot]: res.data as HomepageAssetDto }));
      setHomepageCacheBust(Date.now());
      // 同步全局 store —— 用户回到首页时无需等 refresh，直接看到最新图
      void useHomepageAssetsStore.getState().refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e || '上传失败'));
    } finally {
      setUploadingId('');
      setUploadTarget(null);
    }
  };

  const handleDeleteHomepage = async (slot: string) => {
    if (!window.confirm(`确认清除该资源？\nslot=${slot}\n清除后将回退到默认内置素材。`)) return;
    setUploadingId(`homepage::${slot}`);
    setErr('');
    try {
      const res = await deleteHomepageAsset({ slot });
      if (!res.success) throw new Error(res.error?.message || '删除失败');
      setHomepageAssets((prev) => {
        const next = { ...prev };
        delete next[slot];
        return next;
      });
      setHomepageCacheBust(Date.now());
      // 同步全局 store
      void useHomepageAssetsStore.getState().refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e || '删除失败'));
    } finally {
      setUploadingId('');
    }
  };

  const saveBranding = async () => {
    setBrandingSaving(true);
    setErr('');
    try {
      const name = String(brandingName || '').trim();
      const subtitle = String(brandingSubtitle || '').trim();
      const winTitle = String(brandingWindowTitle || '').trim();
      
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
    const uniq = Array.from(new Set(enabledSkins.map((x) => String(x || '').trim()).filter(Boolean)));
    const tail = uniq.filter((x) => x !== 'white' && x !== 'dark').sort((a, b) => a.localeCompare(b));
    return ['__base__', 'white', 'dark', ...tail];
  }, [enabledSkins]);

  const rows: AssetRow[] = useMemo(() => {
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

    if (uploadTarget.mode === 'homepage') {
      // Homepage 上传由专用文件选择器处理（onPickedHomepageFile）
      return;
    }

    if (uploadTarget.mode === 'nohead') {
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
      setCacheBust(Date.now());
      setBroken((p) => {
        const next = { ...p };
        delete next.__branding__;
        delete next.__branding_bg__;
        return next;
      });
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

      setBroken((p) => {
        const next = { ...(p || {}) };
        Object.keys(next).forEach((k) => {
          if (k.startsWith(`${keyNorm}@@`)) delete next[k];
        });
        return next;
      });

      setCacheBust(Date.now());
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e || '删除失败'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-5 overflow-x-hidden">
      <input
        ref={fileRef}
        type="file"
        className="hidden"
        onChange={(e) => void onPickedFile(e.target.files?.[0] ?? null)}
      />

      <TabBar
        variant="gold"
        items={[
          { key: 'homepage', label: '首页资源', icon: <Home size={14} /> },
          { key: 'marketplace', label: '海鲜市场背景', icon: <Store size={14} /> },
          { key: 'desktop', label: 'Desktop 皮肤资源', icon: <Monitor size={14} /> },
          { key: 'single', label: '全局资源', icon: <Layers size={14} /> },
        ]}
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key as 'desktop' | 'single' | 'homepage' | 'marketplace')}
      />

      <input
        ref={homepageFileRef}
        type="file"
        className="hidden"
        onChange={(e) => void onPickedHomepageFile(e.target.files?.[0] ?? null)}
      />

      {activeTab === 'homepage' && (
        <HomepageAssetsSection
          assets={homepageAssets}
          agentSlots={agentSlotList}
          loading={homepageLoading}
          uploadingId={uploadingId}
          cacheBust={homepageCacheBust}
          onUpload={chooseHomepageUpload}
          onDelete={handleDeleteHomepage}
          onReload={() => void reloadHomepage()}
          isMobile={isMobile}
        />
      )}

      {activeTab === 'marketplace' && (
        <MarketplaceAssetsSection
          assets={homepageAssets}
          loading={homepageLoading}
          uploadingId={uploadingId}
          cacheBust={homepageCacheBust}
          onUpload={chooseHomepageUpload}
          onDelete={handleDeleteHomepage}
          onReload={() => void reloadHomepage()}
        />
      )}

      {err && (
        <div
          className="rounded-[12px] px-4 py-3 text-[13px] flex items-center gap-2.5"
          style={{
            background: 'linear-gradient(135deg, rgba(239,68,68,0.1) 0%, rgba(239,68,68,0.05) 100%)',
            border: '1px solid rgba(239,68,68,0.2)',
            color: 'rgba(239,68,68,0.9)',
          }}
        >
          <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'rgba(239,68,68,0.8)' }} />
          {err}
        </div>
      )}

      {/* ==================== 单文件资源 Tab ==================== */}
      {activeTab === 'single' && (
        <GlassCard animated glow className="overflow-hidden">
          <div className="flex items-center justify-between gap-3 mb-5">
            <SectionTitle icon={<User size={16} />} title="无头像兜底" badge="required" />
          </div>
          <p className="text-[12px] mb-5" style={{ color: 'var(--text-muted)' }}>
            固定路径 <code className="font-mono text-[11px] px-1.5 py-0.5 rounded-[6px]" style={{ background: 'var(--bg-input)' }}>/icon/backups/head/nohead.png</code>
          </p>

          <div className={cn('flex gap-5', isMobile ? 'flex-col items-stretch' : 'items-start')}>
            {/* 预览 */}
            <div
              className={cn(
                'relative rounded-[14px] overflow-hidden transition-all duration-200 shrink-0',
                isNoHeadBroken ? 'ring-2 ring-red-500/30' : 'ring-1 ring-white/8',
                isMobile && 'mx-auto'
              )}
              style={{
                width: isMobile ? '100px' : '120px',
                height: isMobile ? '100px' : '120px',
                background: isNoHeadBroken
                  ? 'linear-gradient(135deg, rgba(239,68,68,0.08) 0%, rgba(239,68,68,0.03) 100%)'
                  : 'var(--bg-card, rgba(255, 255, 255, 0.03))',
              }}
            >
                {noHeadPreviewUrl ? (
                  <img
                    src={noHeadPreviewUrl}
                    alt="无头像预览"
                    className="w-full h-full object-contain p-3"
                    onError={() => setBroken((m) => ({ ...(m || {}), __nohead__: true }))}
                    onLoad={() => setBroken((m) => ({ ...(m || {}), __nohead__: false }))}
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>无 URL</span>
                  </div>
                )}
                {isNoHeadBroken && (
                  <div className="absolute inset-0 flex items-center justify-center bg-red-900/20">
                    <span className="text-xs text-red-400">加载失败</span>
                  </div>
                )}
              </div>

            {/* 信息与操作 */}
            <div className="flex-1 min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-muted)' }}>当前地址</div>
              <div
                className="font-mono text-[12px] break-all p-2.5 rounded-[10px]"
                style={{ background: 'var(--bg-card, rgba(255, 255, 255, 0.03))', border: '1px solid var(--bg-card-hover)', color: 'var(--text-secondary)' }}
              >
                {noHeadPreviewUrl || '-'}
              </div>

              <div className="mt-4 flex items-center gap-2 flex-wrap">
                <Button
                  variant="primary"
                  size="xs"
                  onClick={chooseNoHeadUpload}
                  disabled={isUploadingNoHead}
                  className="gap-1.5"
                >
                  <Upload size={13} />
                  {isUploadingNoHead ? '上传中...' : '上传替换'}
                </Button>
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={() => void copyText(noHeadPreviewUrl)}
                  disabled={!noHeadPreviewUrl}
                >
                  复制地址
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => window.open(noHeadPreviewUrl, '_blank', 'noopener,noreferrer')}
                  disabled={!noHeadPreviewUrl}
                >
                  查看原图
                </Button>
              </div>

              <p className="mt-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                建议尺寸 128x128+, PNG 透明通道
              </p>
            </div>
          </div>
        </GlassCard>
      )}

      {/* ==================== Desktop 资源 Tab ==================== */}
      {activeTab === 'desktop' && (
        <div className="flex flex-col gap-4">
          {/* 品牌配置 */}
          <GlassCard animated glow className="overflow-hidden">
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <SectionTitle icon={<Monitor size={16} />} title="品牌配置" badge="Desktop" />
                <p className="mt-1.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                  Desktop 客户端登录页品牌信息
                </p>
              </div>
              <Button
                variant="primary"
                size="xs"
                onClick={() => void saveBranding()}
                disabled={brandingSaving}
                className="gap-1.5 shrink-0"
              >
                <Save size={13} />
                {brandingSaving ? '保存中...' : '保存配置'}
              </Button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <InputField
                label="大标题"
                value={brandingName}
                onChange={setBrandingName}
                placeholder="PRD Agent"
              />
              <InputField
                label="副标题"
                value={brandingSubtitle}
                onChange={setBrandingSubtitle}
                placeholder="智能PRD解读助手"
              />
              <InputField
                label="窗口标题"
                value={brandingWindowTitle}
                onChange={setBrandingWindowTitle}
                placeholder="PRD Agent"
              />
            </div>
          </GlassCard>

          {/* 快速创建 */}
          <GlassCard animated glow className="overflow-hidden">
            <SectionTitle icon={<Plus size={16} />} title="快速创建" />
            <p className="mt-1.5 mb-4 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              资源根目录：<code className="font-mono text-[10px] px-1.5 py-0.5 rounded-[6px]" style={{ background: 'var(--bg-input)' }}>{desktopRoot || '-'}</code>
            </p>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* 新建皮肤 */}
              <div
                className="p-3.5 rounded-[12px]"
                style={{ background: 'var(--bg-card, rgba(255, 255, 255, 0.03))', border: '1px solid var(--bg-card-hover)' }}
              >
                <div className="flex items-center gap-2 mb-2.5">
                  <Palette size={13} style={{ color: 'var(--accent-gold)' }} />
                  <span className="text-[11px] font-semibold" style={{ color: 'var(--text-secondary)' }}>新建皮肤</span>
                </div>
                <div className="flex items-end gap-2">
                  <InputField
                    value={newSkin}
                    onChange={setNewSkin}
                    placeholder="white / dark / blue"
                    className="flex-1"
                    mono
                  />
                  <Button
                    variant="secondary"
                    size="xs"
                      onClick={() => void onCreateSkin()}
                      disabled={loading}
                      className="shrink-0 h-10"
                    >
                      创建
                    </Button>
                  </div>
                </div>

                {/* 新建 Key */}
              <div
                className="p-3.5 rounded-[12px]"
                style={{ background: 'var(--bg-card, rgba(255, 255, 255, 0.03))', border: '1px solid var(--bg-card-hover)' }}
              >
                <div className="flex items-center gap-2 mb-2.5">
                  <FolderOpen size={13} style={{ color: 'var(--accent-gold)' }} />
                  <span className="text-[11px] font-semibold" style={{ color: 'var(--text-secondary)' }}>新建资源 Key</span>
                </div>
                <div className="flex items-end gap-2 flex-wrap">
                  <InputField
                    value={newKey}
                    onChange={setNewKey}
                    placeholder="例如 load"
                    className={isMobile ? 'w-full' : 'flex-1'}
                    mono
                  />
                  <SelectField
                    value={newKeyKind}
                    onChange={(v) => setNewKeyKind(v as AssetKind)}
                    options={[
                      { value: 'image', label: 'image' },
                      { value: 'audio', label: 'audio' },
                      { value: 'video', label: 'video' },
                      { value: 'other', label: 'other' },
                    ]}
                    className="w-24 shrink-0"
                  />
                  <InputField
                    value={newKeyDesc}
                    onChange={setNewKeyDesc}
                    placeholder="描述（可选）"
                    className={isMobile ? 'w-full' : 'flex-1'}
                  />
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={() => void onCreateKey()}
                    disabled={loading}
                    className="shrink-0"
                  >
                    创建
                  </Button>
                </div>
              </div>
            </div>
          </GlassCard>

          {/* 资源矩阵 */}
          <GlassCard animated glow className="overflow-hidden">
            <SectionTitle icon={<Layers size={16} />} title="资源矩阵" />
            <p className="mt-1.5 mb-4 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              点击缩略图上传/替换资源，红色边框表示缺失，黄色虚线表示回落到默认
            </p>

            {/* 矩阵表格 */}
            <div
              className="rounded-[12px] overflow-hidden"
              style={{
                background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
                border: '1px solid var(--bg-card-hover)',
              }}
            >
              <div className="overflow-x-auto">
                <div style={{ minWidth: `${180 + columns.length * 100}px` }}>
                {/* 表头 */}
                <div
                  className="grid"
                  style={{
                    gridTemplateColumns: `minmax(160px, 1fr) repeat(${columns.length}, minmax(90px, 1fr))`,
                    borderBottom: '1px solid var(--bg-card-hover)',
                    background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
                  }}
                >
                  <div
                    className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    资源项
                  </div>
                  {columns.map((c) => (
                    <div
                      key={c}
                      className="px-2 py-2.5 text-[11px] font-semibold text-center"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {c === '__base__' ? '默认' : labelForSkin(c)}
                    </div>
                  ))}
                </div>

                {/* 数据行 */}
                {rows.map((row) => (
                  <AssetRowBlock
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

                {rows.length === 0 && (
                  <div
                    className="px-4 py-8 text-center text-sm"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    暂无资源项
                  </div>
                )}
                </div>
              </div>
            </div>
          </GlassCard>
        </div>
      )}
    </div>
  );
}

function AssetRowBlock(props: {
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

  const matrixRow = matrixData.find(m => m.key === row.key);
  const displayTitle = matrixRow?.description || row.title;

  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: `minmax(180px, 1fr) repeat(${columns.length}, minmax(100px, 1fr))`,
        borderBottom: '1px solid var(--bg-input)',
      }}
    >
      {/* 行标题 */}
      <div className="px-4 py-3 flex flex-col justify-center">
        <div className="flex items-center gap-2">
          <Image size={12} style={{ color: 'var(--text-muted)' }} />
          <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
            {displayTitle}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <code className="text-[11px] font-mono truncate" style={{ color: 'var(--text-muted)' }}>
            {row.key}
          </code>
          {row.required && (
            <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(var(--accent-gold-rgb), 0.15)', color: 'var(--accent-gold)' }}>
              required
            </span>
          )}
        </div>
        {!row.required && (
          <button
            type="button"
            onClick={onDelete}
            className="mt-2 inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded transition-colors hover:bg-red-500/10"
            style={{ color: 'rgba(239, 68, 68, 0.8)', border: '1px solid rgba(239, 68, 68, 0.2)' }}
          >
            <Trash2 size={10} />
            删除
          </button>
        )}
      </div>

      {/* 各皮肤的资源格子 */}
      {columns.map((c) => {
        const skin = c === '__base__' ? null : c;
        const skinKey = c === '__base__' ? '' : c;
        
        const mRow = matrixData.find(m => m.key === row.key);
        const cell = mRow?.cells?.[skinKey];
        const url = cell?.url || '';
        const isFallback = cell?.isFallback ?? false;
        
        const id = `${row.key}@@${c}`;
        const isBroken = !url || Boolean(broken?.[id]);
        const isUploading = uploadingId === `${row.key}@@${skin || '__base__'}`;
        
        const fileName = url ? url.split('/').pop()?.split('?')[0] || row.key : row.key;
        const isVideo = fileName.toLowerCase().endsWith('.mp4') || 
                       fileName.toLowerCase().endsWith('.webm') || 
                       fileName.toLowerCase().endsWith('.mov');

        return (
          <div
            key={id}
            className="p-2 flex items-center justify-center"
          >
            <div
              className={cn(
                'relative w-[88px] h-[88px] rounded-xl overflow-hidden cursor-pointer transition-all duration-200',
                'hover:ring-2 hover:ring-[var(--accent-gold)]/40 hover:scale-105',
                isBroken && 'ring-2 ring-red-500/40',
                isFallback && !isBroken && 'ring-1 ring-yellow-500/40 ring-dashed',
                !isBroken && !isFallback && 'ring-1 ring-white/10',
                isUploading && 'opacity-50 pointer-events-none'
              )}
              style={{
                background: isBroken
                  ? 'linear-gradient(135deg, rgba(239,68,68,0.08) 0%, rgba(239,68,68,0.02) 100%)'
                  : isFallback
                    ? 'linear-gradient(135deg, rgba(234,179,8,0.06) 0%, rgba(234,179,8,0.02) 100%)'
                    : 'linear-gradient(135deg, var(--nested-block-bg) 0%, var(--bg-card, rgba(255, 255, 255, 0.03)) 100%)',
              }}
              title={isUploading ? '上传中...' : (url ? `点击替换\n${url}` : '点击上传')}
              onClick={() => !isUploading && onUpload(skin, row.key)}
            >
              {url ? (
                isVideo ? (
                  <video
                    src={url}
                    className="w-full h-full object-contain p-1"
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
                    className="w-full h-full object-contain p-1"
                    onError={() => onBroken(id)}
                    onLoad={() => onRecovered(id)}
                  />
                )
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center gap-1">
                  <Upload size={16} style={{ color: 'var(--text-muted)' }} />
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {isUploading ? '上传中' : '点击上传'}
                  </span>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ==================== 首页资源：卡片背景 + Agent 封面 ====================

function appendHomepageCache(url: string, bust: number): string {
  const u = String(url || '').trim();
  if (!u) return '';
  const v = Number.isFinite(bust) ? String(Math.floor(bust)) : '';
  if (!v) return u;
  return u.includes('?') ? `${u}&v=${encodeURIComponent(v)}` : `${u}?v=${encodeURIComponent(v)}`;
}

function humanSize(bytes?: number | null) {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function HomepageAssetsSection({
  assets,
  agentSlots,
  loading,
  uploadingId,
  cacheBust,
  onUpload,
  onDelete,
  onReload,
  isMobile,
}: {
  assets: Record<string, HomepageAssetDto>;
  agentSlots: HomepageAgentSlot[];
  loading: boolean;
  uploadingId: string;
  cacheBust: number;
  onUpload: (slot: string, accept?: string) => void;
  onDelete: (slot: string) => void;
  onReload: () => void;
  isMobile: boolean;
}) {
  // CDN 基址：用于给未上传的 Agent slot 合成「当前默认」预览
  const cdnBase = useAuthStore((s) => s.cdnBaseUrl ?? '');
  return (
    <div className="flex flex-col gap-4">
      {/* 首页顶部 Hero Banner */}
      <GlassCard animated glow className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 mb-4">
          <SectionTitle icon={<PanelTop size={16} />} title="首页顶部 Banner" badge={`${HOMEPAGE_HERO_SLOTS.length} 张`} />
          <Button variant="ghost" size="xs" onClick={onReload} disabled={loading}>
            {loading ? '加载中…' : '刷新'}
          </Button>
        </div>
        <p className="text-[12px] mb-4" style={{ color: 'var(--text-muted)' }}>
          登录后首页最上方的大图。建议宽屏 1920×640 左右，文字主要在左侧，右侧留白区域会作为主体显示。
          上传直接覆盖老路径 <code className="font-mono text-[10px] px-1 py-0.5 rounded" style={{ background: 'var(--bg-input)' }}>icon/title/home.png</code>。
        </p>
        <div className="grid grid-cols-1 gap-3">
          {HOMEPAGE_HERO_SLOTS.map((hero: HomepageHeroSlot) => (
            <HomepageSlotTile
              key={hero.slot}
              slot={hero.slot}
              label={hero.label}
              hint={hero.hint}
              asset={assets[hero.slot]}
              defaultUrl={buildDefaultHeroUrl(cdnBase, hero.id)}
              allowDelete={false}
              cacheBust={cacheBust}
              uploading={uploadingId === `homepage::${hero.slot}`}
              accept="image/*"
              previewAspect="3 / 1"
              onUpload={() => onUpload(hero.slot, 'image/*')}
              onDelete={() => onDelete(hero.slot)}
            />
          ))}
        </div>
      </GlassCard>

      {/* 四张快捷卡背景 */}
      <GlassCard animated glow className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 mb-4">
          <SectionTitle icon={<Home size={16} />} title="首页快捷卡背景" badge="4 张" />
        </div>
        <p className="text-[12px] mb-4" style={{ color: 'var(--text-muted)' }}>
          登录后首页「海鲜市场 / 智识殿堂 / 作品广场 / 更新中心」四张卡片的背景图。
          推荐 3:2 横版图片，建议 480×320 以上。未上传时保持默认渐变。
        </p>

        <div
          className="grid gap-3"
          style={{
            gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)',
          }}
        >
          {HOMEPAGE_CARD_SLOTS.map((card: HomepageCardSlot) => (
            <HomepageSlotTile
              key={card.slot}
              slot={card.slot}
              label={card.label}
              hint={card.hint}
              asset={assets[card.slot]}
              cacheBust={cacheBust}
              uploading={uploadingId === `homepage::${card.slot}`}
              accept="image/*"
              previewAspect="3 / 2"
              onUpload={() => onUpload(card.slot, 'image/*')}
              onDelete={() => onDelete(card.slot)}
            />
          ))}
        </div>
      </GlassCard>

      {/* 智能体封面图 + 视频 */}
      <GlassCard animated glow className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 mb-4">
          <SectionTitle icon={<Sparkles size={16} />} title="智能体封面（图片 + 动态视频）" badge={`${agentSlots.length} 个`} />
        </div>
        <p className="text-[12px] mb-4" style={{ color: 'var(--text-muted)' }}>
          每个 Agent 支持上传一张封面图（静态）+ 一段短视频（hover 时播放）。未上传时回退到 CDN 内置素材。
          视频建议 mp4 / webm，时长 3–6 秒，单文件 &lt;= 20MB。
        </p>

        <div
          className="grid gap-3"
          style={{
            gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(260px, 1fr))',
          }}
        >
          {agentSlots.map((agent: HomepageAgentSlot) => {
            const imageSlot = `agent.${agent.agentKey}.image`;
            const videoSlot = `agent.${agent.agentKey}.video`;
            const defaultImage = buildDefaultCoverUrl(cdnBase, agent.agentKey);
            const defaultVideo = buildDefaultVideoUrl(cdnBase, agent.agentKey);
            return (
              <div
                key={agent.agentKey}
                className="p-3 rounded-[12px]"
                style={{ background: 'var(--bg-card, rgba(255, 255, 255, 0.03))', border: '1px solid var(--bg-card-hover)' }}
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                    {agent.label}
                  </span>
                  <code className="text-[10px] font-mono truncate" style={{ color: 'var(--text-muted)' }}>
                    {agent.agentKey}
                  </code>
                </div>
                {agent.description && (
                  <div className="text-[11px] mb-2 line-clamp-1" style={{ color: 'var(--text-muted)' }}>
                    {agent.description}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <HomepageSlotTile
                    slot={imageSlot}
                    label="封面图"
                    hint="静态 · 默认展示"
                    asset={assets[imageSlot]}
                    defaultUrl={defaultImage}
                    allowDelete={false}
                    cacheBust={cacheBust}
                    uploading={uploadingId === `homepage::${imageSlot}`}
                    accept="image/*"
                    previewAspect="16 / 9"
                    icon={<Image size={12} />}
                    onUpload={() => onUpload(imageSlot, 'image/*')}
                    onDelete={() => onDelete(imageSlot)}
                  />
                  <HomepageSlotTile
                    slot={videoSlot}
                    label="动态视频"
                    hint="hover 播放"
                    asset={assets[videoSlot]}
                    defaultUrl={defaultVideo}
                    allowDelete={false}
                    cacheBust={cacheBust}
                    uploading={uploadingId === `homepage::${videoSlot}`}
                    accept="video/mp4,video/webm,video/quicktime"
                    previewAspect="16 / 9"
                    icon={<VideoIcon size={12} />}
                    onUpload={() => onUpload(videoSlot, 'video/mp4,video/webm,video/quicktime')}
                    onDelete={() => onDelete(videoSlot)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </GlassCard>
    </div>
  );
}

// ==================== 海鲜市场背景 ====================

function MarketplaceAssetsSection({
  assets,
  loading,
  uploadingId,
  cacheBust,
  onUpload,
  onDelete,
  onReload,
}: {
  assets: Record<string, HomepageAssetDto>;
  loading: boolean;
  uploadingId: string;
  cacheBust: number;
  onUpload: (slot: string, accept?: string) => void;
  onDelete: (slot: string) => void;
  onReload: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <GlassCard animated glow className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 mb-4">
          <SectionTitle
            icon={<Store size={16} />}
            title="海鲜市场海报背景"
            badge={`${MARKETPLACE_BG_SLOTS.length} 张`}
          />
          <Button variant="ghost" size="xs" onClick={onReload} disabled={loading}>
            {loading ? '加载中…' : '刷新'}
          </Button>
        </div>
        <p className="text-[12px] mb-4" style={{ color: 'var(--text-muted)' }}>
          海鲜市场整页的大气海报背景。建议 1920×1080 以上、深色海洋主题（深蓝 / 青绿 / 暗夜色），图片会叠一层半透明暗色保证卡片可读性。
          未上传时使用内置深海蓝渐变。
        </p>
        <div className="grid grid-cols-1 gap-3">
          {MARKETPLACE_BG_SLOTS.map((bg: MarketplaceBgSlot) => (
            <HomepageSlotTile
              key={bg.slot}
              slot={bg.slot}
              label={bg.label}
              hint={bg.hint}
              asset={assets[bg.slot]}
              cacheBust={cacheBust}
              uploading={uploadingId === `homepage::${bg.slot}`}
              accept="image/*"
              previewAspect="16 / 9"
              onUpload={() => onUpload(bg.slot, 'image/*')}
              onDelete={() => onDelete(bg.slot)}
            />
          ))}
        </div>
      </GlassCard>
    </div>
  );
}

function HomepageSlotTile({
  slot,
  label,
  hint,
  asset,
  defaultUrl,
  allowDelete = true,
  cacheBust,
  uploading,
  previewAspect,
  icon,
  onUpload,
  onDelete,
}: {
  slot: string;
  label: string;
  hint?: string;
  asset?: HomepageAssetDto;
  /** 未上传时的默认 CDN 预览地址（存量素材）。图片能加载 = 老系统已有；加载失败 = 老系统也没有 */
  defaultUrl?: string | null;
  /**
   * 是否允许「清除」：
   * - card.* 走独立 COS 路径（icon/homepage/...），清除即回到首页渐变，安全，允许
   * - agent.* 直接覆盖了老 CDN 对象（icon/backups/agent/...），清除只能删 DB 记录，
   *   CDN 文件仍是上次上传的版本，不等于「回到原图」→ 禁用清除避免误导
   */
  allowDelete?: boolean;
  cacheBust: number;
  uploading: boolean;
  /** 预留：由父组件在 onUpload 中传给 <input accept=""/> */
  accept?: string;
  previewAspect: string;
  icon?: React.ReactNode;
  onUpload: () => void;
  onDelete: () => void;
}) {
  const hasUpload = Boolean(asset);
  const uploadedUrl = asset?.url ? appendHomepageCache(asset.url, cacheBust) : '';
  const uploadedIsVideo = Boolean(asset?.mime && asset.mime.startsWith('video/'));
  // 默认态：尝试加载老系统已有素材；若 onError 则回退到空白上传态
  const [defaultFailed, setDefaultFailed] = useState(false);
  const defaultIsVideo = Boolean(defaultUrl && /\.(mp4|webm|mov)(\?|$)/i.test(defaultUrl));
  const showDefault = !hasUpload && !!defaultUrl && !defaultFailed;
  const url = hasUpload ? uploadedUrl : showDefault ? defaultUrl! : '';
  const isVideo = hasUpload ? uploadedIsVideo : defaultIsVideo;
  const statusBadge = hasUpload ? '已替换' : showDefault ? '默认' : '';

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {icon}
          <span className="text-[11px] font-semibold truncate" style={{ color: 'var(--text-secondary)' }}>
            {label}
          </span>
        </div>
        {hint && (
          <span className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
            {hint}
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={onUpload}
        disabled={uploading}
        className={cn(
          'relative w-full overflow-hidden rounded-[10px] transition-all duration-200',
          'hover:ring-2 hover:ring-[var(--accent-gold)]/40',
          url ? 'ring-1 ring-white/10' : 'ring-1 ring-dashed ring-white/15',
          uploading && 'opacity-60 cursor-wait'
        )}
        style={{
          aspectRatio: previewAspect,
          background: url
            ? 'rgba(0,0,0,0.35)'
            : 'linear-gradient(135deg, var(--nested-block-bg) 0%, var(--bg-card, rgba(255, 255, 255, 0.03)) 100%)',
        }}
        title={uploading ? '上传中...' : url ? `点击替换\n${url}` : '点击上传'}
      >
        {url ? (
          isVideo ? (
            <video
              src={url}
              className="w-full h-full object-cover"
              muted
              loop
              autoPlay
              playsInline
              onError={() => !hasUpload && setDefaultFailed(true)}
            />
          ) : (
            <img
              src={url}
              alt={label}
              className="w-full h-full object-cover"
              onError={() => !hasUpload && setDefaultFailed(true)}
            />
          )
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 pointer-events-none">
            <Upload size={16} style={{ color: 'var(--text-muted)' }} />
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              {uploading ? '上传中…' : '点击上传'}
            </span>
          </div>
        )}
        {statusBadge && (
          <span
            className="absolute top-1 left-1 px-1.5 py-0.5 rounded text-[9px] font-semibold pointer-events-none"
            style={{
              background: hasUpload ? 'rgba(34,197,94,0.25)' : 'rgba(148,163,184,0.25)',
              color: hasUpload ? 'rgba(134,239,172,0.95)' : 'rgba(226,232,240,0.9)',
              border: `1px solid ${hasUpload ? 'rgba(34,197,94,0.4)' : 'rgba(148,163,184,0.35)'}`,
            }}
          >
            {statusBadge}
          </span>
        )}
      </button>

      <div className="flex items-center justify-between gap-2 min-h-[18px]">
        <code className="text-[9px] font-mono truncate" style={{ color: 'var(--text-muted)' }}>
          {slot}
        </code>
        <div className="flex items-center gap-2">
          {asset && (
            <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
              {humanSize(asset.sizeBytes)}
            </span>
          )}
          {asset && allowDelete && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              disabled={uploading}
              className="inline-flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded transition-colors hover:bg-red-500/10"
              style={{ color: 'rgba(239, 68, 68, 0.8)', border: '1px solid rgba(239, 68, 68, 0.2)' }}
            >
              <Trash2 size={9} />
              清除
            </button>
          )}
          {asset && !allowDelete && (
            <span
              className="text-[9px]"
              style={{ color: 'var(--text-muted)' }}
              title="Agent 封面直接覆盖了老 CDN 文件，无法一键回到原图。如需更换请直接上传新文件"
            >
              替换即可
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
