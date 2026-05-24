import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { Hash, Store, UploadCloud, Zap } from 'lucide-react';

export interface MarketplaceSideRailProps {
  /** 各类型条目数量（key 与 CONFIG_TYPE_REGISTRY 对齐） */
  counts: Record<string, number>;
  /** 分类（已去掉"全部"，技能在前） */
  categories: Array<{ key: string; label: string; icon?: LucideIcon }>;
  categoryFilter: string;
  onSelectCategory: (key: string) => void;
  /** 技能标签云（仅技能 tab 有意义） */
  skillTags: Array<{ tag: string; count: number }>;
  tagFilter: string;
  onSelectTag: (tag: string) => void;
  /** 当前是否技能 tab（决定中段显示标签云还是市场说明） */
  showTags: boolean;
  onUpload: () => void;
  loading?: boolean;
}

/**
 * 海鲜市场左侧常驻栏。
 *
 * 设计动机：宽屏下卡片区居中（maxWidth 1400 + margin auto）会在左侧留下一条
 * 空荡的暗色带，用户反馈"空空如也"。本栏占据该空间，且通过父级 flex 的
 * align-items: stretch 撑满内容区高度——卡片越多、页面越长，本栏越长（但技能
 * 卡片本身高度不变）。内容为真实可用的分类导航 + 标签筛选 + 上传入口，不是
 * 纯装饰留白。所有颜色走主题 token，明暗主题自动翻转。
 */
export const MarketplaceSideRail: React.FC<MarketplaceSideRailProps> = ({
  counts,
  categories,
  categoryFilter,
  onSelectCategory,
  skillTags,
  tagFilter,
  onSelectTag,
  showTags,
  onUpload,
  loading,
}) => {
  return (
    <aside className="marketplace-rail">
      <div className="marketplace-rail-inner">
        {/* 顶部：分类概览导航 */}
        <div className="marketplace-rail-section">
          <div className="marketplace-rail-title">
            <Store size={13} />
            市场概览
          </div>
          <div className="marketplace-rail-stats">
            {categories.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => onSelectCategory(key)}
                data-active={categoryFilter === key}
                className="marketplace-rail-stat"
              >
                <span className="marketplace-rail-stat-label">
                  {Icon && <Icon size={14} />}
                  {label}
                </span>
                <span className="marketplace-rail-stat-count">
                  {loading ? '·' : counts[key] ?? 0}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* 中段（撑满剩余高度）：技能标签云 / 市场说明 */}
        <div className="marketplace-rail-mid">
          {showTags && skillTags.length > 0 ? (
            <>
              <div className="marketplace-rail-title">
                <Hash size={12} />
                热门标签
              </div>
              <div className="marketplace-rail-tags">
                <button
                  type="button"
                  onClick={() => onSelectTag('')}
                  data-active={!tagFilter}
                  className="marketplace-tag-pill"
                >
                  不限
                </button>
                {skillTags.map(({ tag, count }) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => onSelectTag(tag)}
                    data-active={tagFilter === tag}
                    className="marketplace-tag-pill"
                  >
                    #{tag}
                    <span className="ml-1 opacity-60">{count}</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="marketplace-rail-intro">
              <p>海鲜市场汇集团队沉淀的技能、提示词、风格图与水印配置。</p>
              <ul>
                <li>找到合适的，点「拿来吧」一键收入囊中</li>
                <li>「接入 AI」生成 Key，让 Claude Code / Cursor 直接安装</li>
                <li>把自己的好东西上传，攒人气</li>
              </ul>
            </div>
          )}
        </div>

        {/* 底部：上传入口 */}
        <div className="marketplace-rail-footer">
          <button type="button" onClick={onUpload} className="marketplace-rail-cta">
            <UploadCloud size={14} />
            上传你的技能
          </button>
          <p className="marketplace-rail-hint">
            <Zap size={11} />
            支持「接入 AI」一键安装到任意 Agent
          </p>
        </div>
      </div>
    </aside>
  );
};

export default MarketplaceSideRail;
