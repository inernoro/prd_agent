import type { ReactNode } from 'react';
import { SegmentPills, type SegmentOption } from './SegmentPills';

/** 网页创作与海鲜市场共用显示面板；业务选项、附加筛选由调用方传入。 */
export function ListDisplayOptions<TSort extends string, TSize extends string>({
  sortOptions, sort, onSortChange, cardSizeOptions, cardSize, onCardSizeChange,
  sortTourId, cardSizeTourId, rememberPreferences = false, children,
}: {
  sortOptions: readonly SegmentOption<TSort>[];
  sort: TSort;
  onSortChange: (value: TSort) => void;
  cardSizeOptions: readonly SegmentOption<TSize>[];
  cardSize: TSize;
  onCardSizeChange: (value: TSize) => void;
  sortTourId?: string;
  cardSizeTourId?: string;
  rememberPreferences?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="space-y-3" style={{ minWidth: 260 }} data-list-display-options>
      <div className="space-y-1">
        <div className="text-[11px] font-semibold text-token-muted">排序</div>
        <div data-tour-id={sortTourId}>
          <SegmentPills options={sortOptions} value={sort} onChange={onSortChange} ariaLabel="排序" />
        </div>
      </div>
      <div className="space-y-1">
        <div className="text-[11px] font-semibold text-token-muted">卡片尺寸</div>
        <div data-tour-id={cardSizeTourId}>
          <SegmentPills options={cardSizeOptions} value={cardSize} onChange={onCardSizeChange} ariaLabel="卡片尺寸" />
        </div>
      </div>
      {children}
      {rememberPreferences && <div className="text-[11px] text-token-muted">偏好会被记住，下次进来沿用。</div>}
    </div>
  );
}
