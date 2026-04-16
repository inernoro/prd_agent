import { useEffect, useState } from 'react';
import { Globe, Share2, Trash2, ExternalLink, Inbox } from 'lucide-react';
import type { HostedSite } from '@/services/real/webPages';

/**
 * 拖拽 dataTransfer 的自定义 MIME 类型。
 * WebPagesPage 的卡片 onDragStart 写入 siteId，ShareDock 的 onDrop 读取并派发到对应槽位。
 */
export const SHARE_DOCK_MIME = 'application/x-map-site-id';

export interface ShareDockProps {
  /** 当前所有 Visibility=public 的站点（用于徽章计数） */
  publicSites: HostedSite[];
  /** 当前登录用户的 username，用于构造 /u/:username 链接 */
  username?: string;
  /** 拖到 🌍 公开 槽位的回调（建议在父组件中弹二次确认） */
  onMakePublic: (site: HostedSite) => void;
  /** 拖到 📤 分享 槽位的回调（建议打开现有的分享对话框） */
  onShare: (site: HostedSite) => void;
  /** 拖到 🗑️ 删除 槽位的回调（建议在父组件中弹二次确认） */
  onDelete: (site: HostedSite) => void;
  /** 根据 siteId 查找 HostedSite，Dock 只通过 dataTransfer 拿到 id */
  getSiteById: (id: string) => HostedSite | undefined;
}

type SlotKey = 'public' | 'share' | 'delete';

interface SlotDef {
  key: SlotKey;
  icon: React.ReactNode;
  label: string;
  hint: string;
  /** Tailwind 背景 + 边框主题，dragover 时会额外加 ring */
  tone: string;
  hoverTone: string;
}

const SLOTS: SlotDef[] = [
  {
    key: 'public',
    icon: <Globe size={20} />,
    label: '公开',
    hint: '任何人可在 /u/主页查看',
    tone: 'from-sky-500/15 to-cyan-400/5 border-sky-400/25 text-sky-100',
    hoverTone: 'ring-sky-300/70 from-sky-500/35 to-cyan-400/20',
  },
  {
    key: 'share',
    icon: <Share2 size={20} />,
    label: '分享',
    hint: '生成点对点链接',
    tone: 'from-violet-500/15 to-purple-400/5 border-violet-400/25 text-violet-100',
    hoverTone: 'ring-violet-300/70 from-violet-500/35 to-purple-400/20',
  },
  {
    key: 'delete',
    icon: <Trash2 size={20} />,
    label: '回收站',
    hint: '永久删除',
    tone: 'from-rose-500/15 to-red-400/5 border-rose-400/25 text-rose-100',
    hoverTone: 'ring-rose-300/70 from-rose-500/35 to-red-400/20',
  },
];

export function ShareDock({
  publicSites,
  username,
  onMakePublic,
  onShare,
  onDelete,
  getSiteById,
}: ShareDockProps) {
  const [dragging, setDragging] = useState(false);
  const [hoverSlot, setHoverSlot] = useState<SlotKey | null>(null);

  // 监听全局拖拽状态：卡片开始拖动时点亮 Dock，结束时熄灭
  useEffect(() => {
    const onStart = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes(SHARE_DOCK_MIME)) {
        setDragging(true);
      }
    };
    const onEnd = () => {
      setDragging(false);
      setHoverSlot(null);
    };
    document.addEventListener('dragstart', onStart);
    document.addEventListener('dragend', onEnd);
    document.addEventListener('drop', onEnd);
    return () => {
      document.removeEventListener('dragstart', onStart);
      document.removeEventListener('dragend', onEnd);
      document.removeEventListener('drop', onEnd);
    };
  }, []);

  const handleDrop = (e: React.DragEvent, slot: SlotKey) => {
    e.preventDefault();
    const id = e.dataTransfer.getData(SHARE_DOCK_MIME);
    setHoverSlot(null);
    setDragging(false);
    if (!id) return;
    const site = getSiteById(id);
    if (!site) return;
    if (slot === 'public') onMakePublic(site);
    else if (slot === 'share') onShare(site);
    else if (slot === 'delete') onDelete(site);
  };

  const publicCount = publicSites.length;
  const publicUrl = username ? `/u/${encodeURIComponent(username)}` : null;

  return (
    <div
      className="pointer-events-none fixed right-4 top-24 z-40 select-none"
      aria-label="拖拽面板"
    >
      <div
        className={[
          'pointer-events-auto w-[188px] overflow-hidden rounded-2xl border border-white/15',
          'bg-black/30 backdrop-blur-xl shadow-2xl shadow-black/40 transition-all duration-200',
          dragging ? 'scale-[1.03] border-white/30 shadow-[0_0_32px_rgba(56,189,248,0.25)]' : '',
        ].join(' ')}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between border-b border-white/10 bg-white/5 px-3 py-2 text-[11px]">
          <span className="flex items-center gap-1.5 text-white/80">
            <Inbox size={13} />
            <span className="font-medium tracking-wide">投放面板</span>
          </span>
          {publicCount > 0 && (
            <span className="inline-flex min-w-[20px] items-center justify-center rounded-full bg-sky-500/30 px-1.5 py-0.5 text-[10px] font-semibold text-sky-100">
              {publicCount}
            </span>
          )}
        </div>

        {/* 3 个槽位 */}
        <div className="flex flex-col gap-2 p-2">
          {SLOTS.map((s) => {
            const isHover = hoverSlot === s.key;
            return (
              <div
                key={s.key}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setHoverSlot(s.key);
                }}
                onDragLeave={() => setHoverSlot((cur) => (cur === s.key ? null : cur))}
                onDrop={(e) => handleDrop(e, s.key)}
                className={[
                  'rounded-xl border bg-gradient-to-br px-3 py-2 transition-all',
                  s.tone,
                  isHover ? `ring-2 scale-[1.04] ${s.hoverTone}` : '',
                  dragging && !isHover ? 'opacity-95' : '',
                ].join(' ')}
                role="button"
                aria-label={`拖到此处以${s.label}`}
              >
                <div className="flex items-center gap-2">
                  {s.icon}
                  <span className="text-sm font-medium">{s.label}</span>
                </div>
                <div className="mt-0.5 text-[10.5px] leading-snug text-white/55">{s.hint}</div>
              </div>
            );
          })}
        </div>

        {/* 底部：公开页链接或占位说明 */}
        <div className="border-t border-white/10 bg-black/20 px-3 py-2 text-[10.5px]">
          {publicCount > 0 && publicUrl ? (
            <a
              href={publicUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-white/70 transition-colors hover:text-white"
            >
              <ExternalLink size={11} />
              已公开 {publicCount} 个 · 查看公开页
            </a>
          ) : (
            <span className="text-white/40">拖卡片到上方槽位</span>
          )}
        </div>
      </div>
    </div>
  );
}
