| feat | prd-admin | 百宝箱新增「公开市场」分类 tab，可浏览/搜索/Fork 他人公开发布的智能体到自己的百宝箱 |
| feat | prd-admin | 自定义工具卡片 hover 显示快捷「编辑」按钮，已公开的卡片左下角显示绿色「已公开」徽章 |
| fix | prd-admin | ToolDetail 切换发布状态后立即同步到 store.items，回到 grid 徽章实时刷新（之前需刷新页面） |
| fix | prd-admin | 百宝箱按钮文案去歧义：「自定义副本」→「复制并编辑」、「分享」→「分享对话」、「发布」→「公开发布」，并加 tooltip 说明各自动作和影响 |
| feat | prd-admin | 「公开发布」首次点击时弹原生确认框，避免误把私人智能体公开给所有人 |
| feat | prd-admin | 百宝箱卡片 hover 时右上角直接显示操作浮条：自定义卡片「编辑 / 公开发布 / 删除」，内置可 Fork 卡片「复制并编辑」，不再需要先进详情页 |
| fix | prd-admin | 用户自建工具被误识别为"系统内置"根因修复：后端 ToolboxItem 模型没有 Type 字段，store.loadItems 补归一化 + 多处 fallback 用 createdBy/createdByName 判定，作者头像、编辑按钮、详情页「编辑」等 custom-only UI 恢复正常 |
| feat | prd-admin | 百宝箱卡片 footer 语义重构：定制版显示「定制版」徽章；其它卡片（内置对话/用户自建/公开市场）统一显示作者头像+名字；用户自建工具未公开显示橙色「施工中」、已公开显示绿色「已公开」；「系统内置」徽章移除 |
| fix | prd-admin | 用户自建工具作者显示"未知"兜底优化：后端 GetUserName() 依赖 JWT name claim 可能为空，前端 fallback 改用 authStore 当前登录用户的 displayName/username，最终兜底为"我" |
| feat | prd-admin | 内置对话型智能体（代码审查员/翻译/摘要/数据分析师）统一标记为「官方」作者，与用户自建工具共用 footer 样式 |
| feat | prd-admin | 创建智能体成功后：① toast 明确提示"默认仅你自己可见，点卡片右上角 🌍 公开发布" ② 卡片右上角的「公开发布」按钮自动脉动高亮（绿色光环 + 常驻可见），用户点过或成功公开后自动移除，防止用户以为"创建即共享" |
| feat | prd-api | ToolboxItem 新增 CreatedByAvatarFileName 字段，Create 和 Fork 时查 Users 集合写入创建者头像 + DisplayName（之前只存 JWT name claim 可能为空） |
| feat | prd-admin | 百宝箱卡片底部头像从"首字母圆形块"改为真实头像图片：优先用后端返回的 createdByAvatarFileName 经 resolveAvatarUrl 拼 CDN（适用公开市场里别人的卡片），其次 authStore 当前用户 avatarUrl，首字母块仅作最终兜底 |
