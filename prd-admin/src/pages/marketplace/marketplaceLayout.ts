/** 市场卡片的显示规格；只决定布局，不包含业务分类。 */
export const MARKETPLACE_CARD_SIZES = {
  small: { label: '小', minWidth: 224 },
  medium: { label: '中', minWidth: 264 },
  large: { label: '大', minWidth: 320 },
} as const;

export type MarketplaceCardSize = keyof typeof MARKETPLACE_CARD_SIZES;
