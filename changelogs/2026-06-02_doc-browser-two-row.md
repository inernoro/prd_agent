| refactor | prd-admin | 知识库/文档列表条目恢复两行布局：标题独占整行并增强（更亮/加粗/13px），验收·标签·NEW 徽章下移至第二行左对齐、时间右对齐，避免徽章挤占标题宽度 |
| refactor | prd-admin | 文档条目徽章药丸高度 16→15px 略缩，tag 去掉加粗，并按名字本地化排序（从左到右） |
| feat | prd-admin | 知识库列表新增左侧验收状态色条（通过/有条件/不通过 → 绿/琥珀/红竖条），整列向下可扫读结论分布 |
| feat | prd-admin | 知识库列表按时间分组小标题（今天/昨天/本周/本月/更早），仅 created/updated-desc 且非搜索态生效，文件夹不参与分组 |
| feat | prd-admin | 条目标签可点击即按该标签筛选，与顶部筛选条共用 selectedTags（SSOT），激活态加描边；新增 buildDisplayItems 分组单测 |
| fix | prd-admin | 知识库行内标签随侧栏宽度自适应：拖宽侧栏后展示更多标签（最多 12）+ 标签名展示更全，不再一律压缩成 +N |
| feat | prd-admin | 顶部标签筛选条标签 >6 个时收进「标签筛选」下拉（createPortal 长方形面板 + 搜索框 + 多选），避免一长串横向溢出 |
| chore | prd-admin | 移除 DocBrowser 代码注释里残留的 emoji，符合无 emoji 规则 |
| feat | prd-admin | 知识库空库时右栏展示完整首访引导（DocEmptyState：线框插画+说明+CTA+「3步开始」），替代原「选择左侧文件」占位 |
| chore | prd-admin | 新增 DocHeadCard（文档头卡片）/ BulkActionBar（批量操作条）展示组件，下一波接线进阅读区与列表多选 |
| fix | prd-admin | 知识库条目徽章行恒为单行：行内 tag 去掉 flex-wrap 改 overflow 裁切（+N 永久可见）+ 窄栏更激进收进 +N，杜绝标签竖直堆叠 |
