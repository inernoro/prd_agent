/**
 * 文档头卡片（DocHeadCard）
 *
 * 纯展示组件，渲染在文档阅读区顶部：大标题 + 一行 meta（验收药丸 / 标签药丸 /
 * 作者 / 创建·更新时间 / 浏览数 / 点赞数）。无内部状态、无副作用。
 *
 * 颜色约定：
 * - 主题相关的文字/背景/边框一律走 CSS 变量 var(--xxx)，保证暗黑/白天两个主题都清晰。
 * - 验收药丸颜色取自 getVerdictConfig（品牌色 rgba，可直接用）。
 * - 标签药丸颜色取自 getTagColor（品牌色 rgba，可直接用）。
 */
import { Eye, Heart } from 'lucide-react';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { getVerdictConfig } from '@/lib/acceptanceVerdictRegistry';
import { getTagColor, truncateTagDisplay } from '@/lib/tagPalette';

export interface DocHeadCardProps {
  title: string;
  /** 'pass'|'conditional'|'fail'，经 getVerdictConfig 取配置；null/未知则不渲染验收药丸 */
  verdict?: string | null;
  /** 如 'L1'，拼到验收药丸文案后："通过 L1" */
  tier?: string | null;
  tags?: string[];
  /** 点标签药丸触发 */
  onTagClick?: (tag: string) => void;
  authorName?: string;
  /** ISO 时间字符串 */
  createdAt?: string;
  /** ISO 时间字符串 */
  updatedAt?: string;
  viewCount?: number;
  likeCount?: number;
}

export function DocHeadCard(props: DocHeadCardProps) {
  const {
    title,
    verdict,
    tier,
    tags,
    onTagClick,
    authorName,
    createdAt,
    updatedAt,
    viewCount,
    likeCount,
  } = props;

  // 验收药丸配置（未知/缺失为 null，则不渲染）
  const verdictConfig = getVerdictConfig(verdict);

  return (
    <div
      // 头部块：上下留白 + 底部 1px 分隔线（与正文分隔）
      style={{
        paddingTop: 9,
        paddingBottom: 9,
        borderBottom: '1px solid var(--border-faint)',
      }}
    >
      {/* 大标题 */}
      <div
        style={{
          fontSize: 19,
          fontWeight: 700,
          lineHeight: 1.35,
          marginBottom: 6,
          color: 'var(--text-primary)',
        }}
      >
        {title}
      </div>

      {/* meta 行 */}
      <div
        className="flex flex-wrap items-center gap-2"
        style={{ fontSize: 10, color: 'var(--text-muted)' }}
      >
        {/* 1. 验收药丸（品牌色，直接用 config 返回值） */}
        {verdictConfig && (
          <span
            className="inline-flex items-center"
            style={{
              height: 16,
              borderRadius: 9999,
              padding: '0 6px',
              fontSize: 9,
              fontWeight: 700,
              lineHeight: 1,
              background: verdictConfig.background,
              color: verdictConfig.color,
              border: verdictConfig.border,
            }}
          >
            {`${verdictConfig.label}${tier ? ' ' + tier : ''}`}
          </span>
        )}

        {/* 2. 标签药丸（品牌色，可点） */}
        {(tags ?? []).map((tag) => {
          const tc = getTagColor(tag);
          return (
            <span
              key={tag}
              title={tag}
              className="inline-flex items-center cursor-pointer"
              style={{
                height: 16,
                borderRadius: 9999,
                padding: '0 6px',
                fontSize: 9,
                lineHeight: 1,
                background: tc.bg,
                color: tc.text,
                border: `1px solid ${tc.border}`,
              }}
              onClick={(e) => {
                e.stopPropagation();
                onTagClick?.(tag);
              }}
            >
              {truncateTagDisplay(tag, 6)}
            </span>
          );
        })}

        {/* 3. 作者：首字母圆头像 + 名字 */}
        {authorName && (
          <span className="inline-flex items-center gap-1">
            <span
              className="inline-flex items-center justify-center shrink-0"
              style={{
                width: 15,
                height: 15,
                borderRadius: 9999,
                background: 'var(--accent-primary, #818cf8)',
                color: '#fff',
                fontSize: 8,
                fontWeight: 600,
                lineHeight: 1,
              }}
            >
              {authorName[0]}
            </span>
            <span style={{ color: 'var(--text-secondary)' }}>{authorName}</span>
          </span>
        )}

        {/* 4. 时间：创建 / · 更新 */}
        {(createdAt || updatedAt) && (
          <span className="inline-flex items-center">
            {createdAt && (
              <>
                创建&nbsp;
                <RelativeTime value={createdAt} refreshIntervalMs={0} />
              </>
            )}
            {updatedAt && (
              <>
                {createdAt ? <>&nbsp;·&nbsp;</> : null}
                更新&nbsp;
                <RelativeTime value={updatedAt} refreshIntervalMs={0} />
              </>
            )}
          </span>
        )}

        {/* 5. 浏览数 */}
        {viewCount != null && (
          <span className="inline-flex items-center gap-1">
            <Eye size={11} />
            {viewCount}
          </span>
        )}

        {/* 6. 点赞数 */}
        {likeCount != null && (
          <span className="inline-flex items-center gap-1">
            <Heart size={10} />
            {likeCount}
          </span>
        )}
      </div>
    </div>
  );
}

export default DocHeadCard;
