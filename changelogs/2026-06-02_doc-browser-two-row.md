| refactor | prd-admin | 知识库/文档列表条目恢复两行布局：标题独占整行并增强（更亮/加粗/13px），验收·标签·NEW 徽章下移至第二行左对齐、时间右对齐，避免徽章挤占标题宽度 |
| refactor | prd-admin | 文档条目徽章药丸高度 16→15px 略缩，tag 去掉加粗，并按名字本地化排序（从左到右） |
| feat | prd-admin | 知识库列表新增左侧验收状态色条（通过/有条件/不通过 → 绿/琥珀/红竖条），整列向下可扫读结论分布 |
| feat | prd-admin | 知识库列表按时间分组小标题（今天/昨天/本周/本月/更早），仅 created/updated-desc 且非搜索态生效，文件夹不参与分组 |
| feat | prd-admin | 条目标签可点击即按该标签筛选，与顶部筛选条共用 selectedTags（SSOT），激活态加描边；新增 buildDisplayItems 分组单测 |
