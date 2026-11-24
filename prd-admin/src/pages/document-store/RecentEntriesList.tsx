/**
 * 「最近」标签的内容时间线。
 *
 * 用户诉求原话：「我总是找不到我刚刚新增的内容」。所以这一屏回答的问题只有一个——
 * **我刚存进来的那篇在哪**。因此：
 *   - 主体是文档条目而不是知识库卡片（按库分组正是让人找不到的原因）；
 *   - 每条都带「存在哪个库」，因为那恰恰是用户想不起来的那个信息；
 *   - 「新增」与「改过」分开标注，用户找的通常是前者（判据由后端给，前端不自己算）；
 *   - 点一条直接落到那篇内容，不是先进库再找。
 */
import { useMemo } from 'react';
import { ChevronRight, Clock, Sparkles } from 'lucide-react';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { getFileTypeConfig } from '@/lib/fileTypeRegistry';
import type { RecentDocumentEntry } from '@/services/contracts/documentStore';
import { groupRecentEntries } from './recentEntriesGroups';

export function RecentEntriesList({
  items,
  onOpen,
}: {
  items: RecentDocumentEntry[];
  onOpen: (entry: RecentDocumentEntry) => void;
}) {
  // now 只在 items 变化时取一次：每帧新建 Date 会让分组结果每次渲染都是新引用
  const groups = useMemo(() => groupRecentEntries(items), [items]);

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <Clock size={40} style={{ color: 'var(--text-muted)', opacity: 0.3, marginBottom: 16 }} />
        <p className="mb-1 text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          还没有最近的内容
        </p>
        <p className="max-w-[360px] text-center text-[11px] leading-[1.6]" style={{ color: 'var(--text-muted)' }}>
          你在任意知识库里新增或修改文档后，这里会按时间倒序列出来，不用回想它当时存进了哪个库
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5" data-tour-id="doc-store-recent-list">
      {groups.map(group => (
        <section key={group.key} className="flex flex-col gap-1.5">
          <div className="flex items-baseline gap-2 px-1">
            <span className="text-[12px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
              {group.label}
            </span>
            <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
              {group.items.length}
            </span>
          </div>
          <div
            className="overflow-hidden rounded-[12px]"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
          >
            {group.items.map((entry, idx) => {
              const cfg = getFileTypeConfig(entry.title, entry.contentType);
              const Icon = cfg.icon;
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => onOpen(entry)}
                  className="flex w-full min-h-[52px] items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--bg-card-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]"
                  style={idx > 0 ? { borderTop: '1px solid var(--border-faint)' } : undefined}
                  title={`打开「${entry.title}」（在 ${entry.storeName}）`}
                >
                  <Icon size={16} style={{ color: cfg.color, flexShrink: 0 }} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                        {entry.title}
                      </span>
                      {entry.isNew && (
                        <span
                          className="flex flex-shrink-0 items-center gap-0.5 rounded-full px-1.5 py-[1px] text-[10px]"
                          style={{
                            background: 'var(--selection-bg)',
                            color: 'var(--selection-text)',
                            border: '1px solid var(--selection-border)',
                          }}
                        >
                          <Sparkles size={9} /> 新增
                        </span>
                      )}
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {/* 「存在哪个库」是这一屏最要紧的一句上下文，不能省 */}
                      <span className="truncate">{entry.storeName || '未知知识库'}</span>
                      <span aria-hidden>·</span>
                      <RelativeTime value={entry.updatedAt} className="flex-shrink-0 tabular-nums" />
                    </span>
                  </span>
                  {/* 右侧只作「点了会进去」的指示，不是第二个动作 */}
                  <ChevronRight size={14} style={{ color: 'var(--text-muted)', opacity: 0.6, flexShrink: 0 }} aria-hidden />
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
