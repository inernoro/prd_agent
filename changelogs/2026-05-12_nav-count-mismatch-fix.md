| fix | prd-admin | 移除 NavLayoutEditor 孤立条目检测的守卫条件，首次加载（无 navOrder）时也正确追加新上线条目，修复侧边栏与导航编辑器数量不一致 |
| fix | prd-api | 为 web-pages/document-store/emergence 添加 personal 分组，使知识库/网页托管/涌现探索出现在侧边栏和默认导航顺序 |
| fix | prd-admin | 修复资源图标（FolderOpen→FolderHeart），新增 Library/Sparkle 图标到 AppShell iconMap |
| fix | prd-admin | 删除导航编辑器顶部冗余提示文字，为图标区域释放可见空间 |
| test | prd-admin | 更新 navMenuSync 护栏测试以匹配新孤立检测逻辑（无守卫条件） |
