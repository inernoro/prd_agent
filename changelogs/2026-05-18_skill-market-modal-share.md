| feat | prd-admin | 海鲜市场技能卡片可点击打开近全屏详情弹窗（左文件树+右预览，默认 SKILL.md，前端 jszip 解压公开 zip 包） |
| feat | prd-admin | 新增技能公开免登录分享：卡片+详情弹窗分享按钮生成链接，外部经 /s/skill/:token 只读浏览 SKILL.md+文件树 |
| feat | prd-api | 新增技能分享链接（MarketplaceSkillShareLink）+ 创建/匿名公开读端点（仅返回公开字段） |
| fix | prd-admin | 修复技能卡片封面图上文字看不清（新增整卡渐变遮罩 + 提高玻璃面板与标题/描述对比度，明暗主题双修） |
| refactor | prd-admin | 抽离知识库 MarkdownViewer/FilePreview 为共享组件 components/file-preview，详情弹窗与分享页复用 |
