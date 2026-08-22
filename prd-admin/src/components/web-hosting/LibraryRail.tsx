import { useState } from 'react';
import { Folder, Grid3X3 } from 'lucide-react';
import { SpaceRailSection, type Space } from '@/components/team/SpaceBar';

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
  spaceHint,
  folders,
  activeFolder,
  onFolder,
  folderCounts,
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
  spaceHint?: string;
  /** 个人空间的文件夹清单；团队空间传 undefined，改用 teamTree */
  folders?: string[];
  activeFolder?: string | null;
  onFolder?: (folder: string | null) => void;
  folderCounts?: Map<string, number>;
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
  const VISIBLE_TAGS = 8;
  const shownTags = tagsExpanded ? tags : tags.slice(0, VISIBLE_TAGS);
  const restTags = tags.length - shownTags.length;

  const chip = (label: string, count: number | null, on: boolean, onClick: () => void, key: string) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] transition-colors"
      style={on
        ? { background: 'var(--selection-bg)', border: '1px solid var(--selection-border)', color: 'var(--selection-text)' }
        : { background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}
    >
      {label}
      {typeof count === 'number' && <span className="tabular-nums opacity-70">{count}</span>}
    </button>
  );

  return (
    <aside
      data-tour-id="webpages-library-rail"
      className="w-[236px] shrink-0 flex flex-col gap-4 rounded-xl p-3"
      style={{
        alignSelf: 'stretch',
        minHeight: 0,
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        background: 'var(--bg-card)',
        border: '1px solid var(--border-default)',
      }}
    >
      <SpaceRailSection current={space} onChange={onChangeSpace} personalCount={personalCount} hint={spaceHint} />

      <div className="space-y-1">
        <div className="flex h-6 items-center justify-between px-1">
          <span className="text-[11px] font-semibold tracking-wide" style={{ color: 'var(--text-muted)' }}>分组</span>
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
        {teamTree ?? (
          <div className="space-y-0.5" data-tour-id="webpages-folders">
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
                className="flex w-full items-center gap-2 rounded-[8px] px-2 h-7 text-[12px] transition-colors"
                style={activeFolder === f
                  ? { background: 'var(--selection-bg)', color: 'var(--selection-text)' }
                  : { color: 'var(--text-primary)' }}
              >
                <Folder size={11} className="shrink-0 opacity-70" />
                <span className="flex-1 truncate text-left">{f}</span>
                {folderCounts?.get(f) !== undefined && (
                  <span className="shrink-0 text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>{folderCounts.get(f)}</span>
                )}
              </button>
            ))}
            {(folders ?? []).length === 0 && (
              <div className="px-2 py-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                上传时填「文件夹」即可在此归档
              </div>
            )}
          </div>
        )}
      </div>

      {tags.length > 0 && (
        <div className="space-y-1.5">
          <div className="px-1 text-[11px] font-semibold tracking-wide" style={{ color: 'var(--text-muted)' }}>标签</div>
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
