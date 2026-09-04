import { useState } from 'react';
import { Folder, Grid3X3, Plus, X } from 'lucide-react';
import { SpaceRailSection, type Space } from '@/components/team/SpaceBar';
import { WEB_PAGE_MIME } from './SiteCard';
import { buildWebPageFolderSlot } from './folderDrop';
import './LibraryRail.css';

/**
 * 主控台常驻左栏（设计稿屏 1·A）：空间 → 分组 → 标签 自上而下三节，
 * 底部留一个跟当前空间相关的动作位。
 *
 * 为什么是常驻栏而不是「筛选」气泡：这三样回答的是「我现在在看哪一批」，
 * 是用户全程都要能看见的定位信息；收进气泡等于每次都要点开才知道自己在哪
 * （`.claude/rules/guided-exploration.md`）。桌面走这一栏，移动端仍走筛选抽屉。
 */
export function LibraryRail({
  space,
  onChangeSpace,
  personalCount,
  teamCount,
  spaceHint,
  folders,
  activeFolder,
  onFolder,
  folderCounts,
  onCreateFolder,
  teamTree,
  tags,
  activeTag,
  onTag,
  filterCount,
  onClearFilters,
  footer,
}: {
  space: Space;
  onChangeSpace: (s: Space) => void;
  personalCount?: number | null;
  teamCount?: number | null;
  spaceHint?: string;
  /** 个人空间的文件夹清单；团队空间传 undefined，改用 teamTree */
  folders?: string[];
  activeFolder?: string | null;
  onFolder?: (folder: string | null) => void;
  folderCounts?: Map<string, number>;
  onCreateFolder?: (name: string) => Promise<boolean>;
  /** 团队空间的专题/分类树（页面传入已配好回调的 TeamGroupsTree） */
  teamTree?: React.ReactNode;
  tags: { tag: string; count: number }[];
  activeTag: string | null;
  onTag: (tag: string | null) => void;
  filterCount: number;
  onClearFilters: () => void;
  footer?: React.ReactNode;
}) {
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [creatingFolderPending, setCreatingFolderPending] = useState(false);
  const VISIBLE_TAGS = 8;
  const shownTags = tagsExpanded ? tags : tags.slice(0, VISIBLE_TAGS);
  const restTags = tags.length - shownTags.length;

  const submitFolder = async () => {
    const name = folderName.trim();
    if (!name || !onCreateFolder || creatingFolderPending) return;
    setCreatingFolderPending(true);
    try {
      const created = await onCreateFolder(name);
      if (created) {
        setFolderName('');
        setCreatingFolder(false);
      }
    } finally {
      setCreatingFolderPending(false);
    }
  };

  const chip = (label: string, count: number | null, on: boolean, onClick: () => void, key: string) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 transition-colors"
      // 设计稿的标签是 11.5px 紧凑矩形（padding 3/7、radius 6），不是全圆角高胶囊
      style={{
        fontSize: 11.5,
        padding: '3px 7px',
        borderRadius: 'var(--radius-chip)',
        ...(on
          ? { background: 'var(--selection-bg)', border: '1px solid var(--selection-border)', color: 'var(--selection-text)' }
          : { background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }),
      }}
    >
      {label}
      {typeof count === 'number' && <span className="tabular-nums opacity-70">{count}</span>}
    </button>
  );

  return (
    <aside
      data-tour-id="webpages-library-rail"
      className="shrink-0 flex flex-col gap-3"
      style={{
        // 设计稿：212px 贴边栏，靠 border-right 与内容区分隔，底色比内容区更暗一档；
        // 不是一块带圆角的浮动卡（那会在左边留出一条与顶栏对不齐的缝）
        width: 212,
        alignSelf: 'stretch',
        minHeight: 0,
        padding: '14px 10px',
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        background: 'var(--bg-rail)',
        borderRight: '1px solid var(--border-subtle)',
      }}
    >
      <SpaceRailSection current={space} onChange={onChangeSpace} personalCount={personalCount} teamCount={teamCount} hint={spaceHint} />

      <div className="space-y-1">
        <div className="flex h-6 items-center justify-between px-1">
          <span style={{ fontFamily: 'var(--font-code)', fontSize: 10, letterSpacing: 'var(--tracking-eyebrow)', color: 'var(--text-tertiary)' }}>分组</span>
          <div className="flex items-center gap-1">
            {onCreateFolder && (
              <button
                type="button"
                onClick={() => { setCreatingFolder((value) => !value); setFolderName(''); }}
                className="inline-flex h-6 items-center gap-1 rounded-[6px] px-1.5 text-[10px] font-medium transition-colors"
                style={{ color: 'var(--text-secondary)' }}
                title="创建一个可拖入网页的文件夹"
                aria-label="创建文件夹"
                data-tour-id="webpages-create-folder"
              >
                {creatingFolder ? <X size={11} /> : <Plus size={11} />}
                {creatingFolder ? '取消' : '文件夹'}
              </button>
            )}
            {filterCount > 0 && (
              <button
                type="button"
                onClick={onClearFilters}
                className="text-[11px]"
                style={{ color: 'var(--text-muted)' }}
                title="清空文件夹 / 标签 / 来源筛选"
              >
                清空筛选 {filterCount}
              </button>
            )}
          </div>
        </div>
        {teamTree ?? (
          <div className="space-y-0.5" data-tour-id="webpages-folders">
            {creatingFolder && (
              <div className="mb-1 flex items-center gap-1">
                <input
                  autoFocus
                  value={folderName}
                  disabled={creatingFolderPending}
                  onChange={(event) => setFolderName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void submitFolder();
                    if (event.key === 'Escape') { setCreatingFolder(false); setFolderName(''); }
                  }}
                  placeholder="文件夹名称"
                  aria-label="文件夹名称"
                  className="h-7 min-w-0 flex-1 rounded-[7px] px-2 text-[11px] outline-none"
                  style={{ background: 'var(--bg-input)', border: '1px solid var(--accent-primary)', color: 'var(--text-primary)' }}
                />
                <button
                  type="button"
                  disabled={!folderName.trim() || creatingFolderPending}
                  onClick={() => void submitFolder()}
                  className="h-7 shrink-0 rounded-[7px] px-2 text-[10px] font-semibold disabled:opacity-40"
                  style={{ background: 'var(--accent-primary)', color: 'var(--accent-on-primary)' }}
                >
                  创建
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={() => onFolder?.(null)}
              className="flex w-full items-center gap-2 rounded-[8px] px-2 h-7 text-[12px] transition-colors"
              style={!activeFolder
                ? { background: 'var(--selection-bg)', color: 'var(--selection-text)' }
                : { color: 'var(--text-primary)' }}
            >
              <Grid3X3 size={11} className="shrink-0 opacity-70" />
              <span className="flex-1 truncate text-left">全部</span>
            </button>
            {(folders ?? []).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => onFolder?.(activeFolder === f ? null : f)}
                className="web-folder-drop-target flex w-full items-center gap-2 rounded-[8px] px-2 h-7 text-[12px] transition-colors"
                data-dock-slot={buildWebPageFolderSlot(f)}
                data-dock-mime={WEB_PAGE_MIME}
                data-tour-id="webpages-folder-drop-target"
                style={activeFolder === f
                  ? { background: 'var(--selection-bg)', color: 'var(--selection-text)' }
                  : { color: 'var(--text-primary)' }}
              >
                <Folder size={11} className="shrink-0 opacity-70" />
                <span className="flex-1 truncate text-left">{f}</span>
                {folderCounts?.get(f) !== undefined && (
                  <span className="web-folder-drop-target__count shrink-0 text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>{folderCounts.get(f)}</span>
                )}
                <span className="web-folder-drop-target__hint">松开移入</span>
              </button>
            ))}
            {(folders ?? []).length === 0 && (
              <div className="px-2 py-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                先创建文件夹，再把右侧网页卡片拖进来
              </div>
            )}
          </div>
        )}
      </div>

      {tags.length > 0 && (
        <div className="space-y-1.5">
          <div className="px-2" style={{ fontFamily: 'var(--font-code)', fontSize: 10, letterSpacing: 'var(--tracking-eyebrow)', color: 'var(--text-tertiary)' }}>标签</div>
          <div className="flex flex-wrap gap-1.5">
            {shownTags.map((t) => chip(t.tag, t.count, activeTag === t.tag, () => onTag(activeTag === t.tag ? null : t.tag), t.tag))}
            {restTags > 0 && (
              <button
                type="button"
                onClick={() => setTagsExpanded(true)}
                className="inline-flex h-7 items-center rounded-full px-2 text-[12px]"
                style={{ color: 'var(--text-muted)' }}
              >
                +{restTags}
              </button>
            )}
          </div>
        </div>
      )}

      {footer && <div className="mt-auto pt-2">{footer}</div>}
    </aside>
  );
}
