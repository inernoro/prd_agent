import { useState } from 'react';
import { Check, Loader2, Palette, Pencil, X } from 'lucide-react';
import { updateMyPublicPage } from '@/services';
import {
  PROFILE_BACKGROUND_THEMES,
  resolveBackgroundTheme,
  type ProfileBackgroundTheme,
} from './profileBackgrounds';

interface OwnerDecoratorProps {
  initialBio: string | null | undefined;
  initialBackground: string | null | undefined;
  onSaved: (patch: { bio: string | null; profileBackground: string | null }) => void;
}

/**
 * 仅对「访问自己公开页」的用户显示：
 *   - 编辑自我介绍（最多 500 字）
 *   - 切换背景主题
 * 保存成功后回调父组件，以便立即更新页面展示。
 */
export function OwnerDecorator({ initialBio, initialBackground, onSaved }: OwnerDecoratorProps) {
  const [open, setOpen] = useState(false);
  const [bio, setBio] = useState(initialBio ?? '');
  const [bgKey, setBgKey] = useState(resolveBackgroundTheme(initialBackground).key);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await updateMyPublicPage(bio.trim() || null, bgKey || null);
      if (res.success) {
        onSaved({ bio: res.data.bio, profileBackground: res.data.profileBackground });
        setJustSaved(true);
        setTimeout(() => setJustSaved(false), 1800);
        setOpen(false);
      } else {
        setError(res.error?.message || '保存失败');
      }
    } catch (e) {
      setError((e as Error).message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-white/20 bg-white/5 px-3 py-1.5 text-xs text-white/75 backdrop-blur-sm transition-all hover:border-white/35 hover:bg-white/10 hover:text-white"
        title="装修我的公开页（仅自己可见入口）"
      >
        <Pencil size={12} />
        <span>装修</span>
        {justSaved && <Check size={12} className="text-emerald-300" />}
      </button>
    );
  }

  return (
    <div className="rounded-2xl border border-white/15 bg-[#0f1014]/90 p-4 backdrop-blur-xl">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-[13px] font-medium text-white/85">
          <Palette size={14} />
          <span>装修我的公开页</span>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md p-1 text-white/55 transition-colors hover:bg-white/10 hover:text-white"
          aria-label="关闭"
        >
          <X size={14} />
        </button>
      </div>

      <div className="mb-4">
        <label className="mb-1.5 block text-[11px] uppercase tracking-wide text-white/50">
          自我介绍（最多 500 字）
        </label>
        <textarea
          value={bio}
          onChange={(e) => setBio(e.target.value.slice(0, 500))}
          placeholder="写一句让访客更了解你的话——你的领域、你擅长什么、你在做什么"
          rows={3}
          className="w-full resize-none rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-[13px] text-white/90 outline-none transition-colors placeholder:text-white/30 focus:border-white/25"
        />
        <div className="mt-1 flex justify-end text-[10px] text-white/40">
          {bio.length} / 500
        </div>
      </div>

      <div className="mb-4">
        <label className="mb-1.5 block text-[11px] uppercase tracking-wide text-white/50">
          背景主题
        </label>
        <div className="grid grid-cols-4 gap-2">
          {PROFILE_BACKGROUND_THEMES.map((t) => (
            <BackgroundSwatch
              key={t.key}
              theme={t}
              active={t.key === bgKey}
              onClick={() => setBgKey(t.key)}
            />
          ))}
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-rose-400/30 bg-rose-500/10 px-3 py-1.5 text-[12px] text-rose-100">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-1.5 text-[12px] text-white/65 transition-colors hover:bg-white/5 hover:text-white/90"
          disabled={saving}
        >
          取消
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500/80 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-60"
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          保存
        </button>
      </div>
    </div>
  );
}

function BackgroundSwatch({
  theme,
  active,
  onClick,
}: {
  theme: ProfileBackgroundTheme;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'relative overflow-hidden rounded-lg border transition-all',
        active
          ? 'border-sky-400/70 ring-2 ring-sky-400/30'
          : 'border-white/10 hover:border-white/25',
      ].join(' ')}
      title={theme.label}
      style={{ aspectRatio: '4 / 3', background: theme.base }}
    >
      <div
        className="absolute inset-0 opacity-80"
        style={{ background: theme.banner }}
      />
      <div className="absolute bottom-1 left-1.5 right-1.5 truncate text-left text-[10px] text-white/80 drop-shadow">
        {theme.label}
      </div>
      {active && (
        <div className="absolute right-1 top-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-sky-400 text-white">
          <Check size={10} />
        </div>
      )}
    </button>
  );
}
