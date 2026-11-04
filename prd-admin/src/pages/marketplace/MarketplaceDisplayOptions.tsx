import { MARKETPLACE_CARD_SIZES, type MarketplaceCardSize } from './marketplaceLayout';

interface Props {
  sort: 'hot' | 'new';
  onSortChange: (sort: 'hot' | 'new') => void;
  size: MarketplaceCardSize;
  onSizeChange: (size: MarketplaceCardSize) => void;
}

export function MarketplaceDisplayOptions({ sort, onSortChange, size, onSizeChange }: Props) {
  return (
    <div className="marketplace-display-options">
      <fieldset>
        <legend>排序</legend>
        <div className="marketplace-display-segments">
          <button type="button" aria-pressed={sort === 'hot'} data-active={sort === 'hot'} onClick={() => onSortChange('hot')}>热门</button>
          <button type="button" aria-pressed={sort === 'new'} data-active={sort === 'new'} onClick={() => onSortChange('new')}>最新</button>
        </div>
      </fieldset>
      <fieldset>
        <legend>卡片尺寸</legend>
        <div className="marketplace-display-segments" aria-label="卡片尺寸">
          {(Object.keys(MARKETPLACE_CARD_SIZES) as MarketplaceCardSize[]).map(value => (
            <button key={value} type="button" aria-pressed={size === value} data-active={size === value} onClick={() => onSizeChange(value)}>
              {MARKETPLACE_CARD_SIZES[value].label}
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
