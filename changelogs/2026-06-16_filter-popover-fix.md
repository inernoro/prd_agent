| fix | prd-admin | 修复产品管理列表「筛选设置」弹层被工具栏 overflow 裁剪导致筛选项看不到：改 createPortal + fixed 锚定按钮定位，滚动自动关闭；筛选下拉宽度上限放宽到 220px 防长标签截断 |
| refactor | prd-admin | FEATURE_TYPE_LABEL/FEATURE_TYPES 提取到 types.ts（消除 FeatureCatalogTab 与 ProductObjectDetailPage 两处重复定义） |
