| feat | prd-api | DailyTip seed 从 2 条扩展到 **5 条多步 Tour 全链路演示**,严格遵守「≥ 2 步」规则:<br>1) `defect-full-flow` 4 步(已有)<br>2) `shortcut-cmd-k` 2 步(已有)<br>3) **`shortcut-cmd-b` 2 步**:首页提示按 ⌘+B 唤起全局缺陷对话框<br>4) **`changelog-weekly` 2 步**:最新版本 → 按模块筛选<br>5) **`library-publish` 3 步**:上传文档 → 发布到智识殿堂 |
| feat | prd-admin | 补 3 个 `data-tour-id` 锚点配合新演示:`changelog-filter`(ChangelogPage 筛选栏)、`document-upload`(DocumentStorePage 上传按钮)、`document-store-publish`(DocumentStorePage 发布按钮) |
| refactor | .claude/skills | 技能 `create-tour-demo` 重命名为 `createzzdemo`(目录 + frontmatter + 文档内所有引用),用户"创建 XX 演示" / "/createzzdemo" 都能触发 |
| docs | doc | `design.daily-tips.md` 把技能名引用同步为 `createzzdemo` |
