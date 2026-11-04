/** 市场卡片的显示规格；只决定布局，不包含业务分类。 */
export const MARKETPLACE_VIEWS = {
  all: { label: '全部内容', empty: '暂无公开配置' },
  favorites: { label: '我的收藏', empty: '还没有收藏技能，点击卡片上的爱心即可收藏' },
  mine: { label: '我的技能', empty: '还没有上传技能，上传后可在这里按分类查找' },
} as const;

export const MARKETPLACE_CARD_SIZES = {
  small: { label: '小', minWidth: 224 },
  medium: { label: '中', minWidth: 264 },
  large: { label: '大', minWidth: 320 },
} as const;

export type MarketplaceCardSize = keyof typeof MARKETPLACE_CARD_SIZES;

export const MARKETPLACE_SORT_OPTIONS = [
  { value: 'hot', label: '热门' },
  { value: 'new', label: '最新' },
] as const;

export const MARKETPLACE_CARD_SIZE_OPTIONS = (Object.keys(MARKETPLACE_CARD_SIZES) as MarketplaceCardSize[])
  .map(value => ({ value, label: MARKETPLACE_CARD_SIZES[value].label }));
