| fix | prd-admin | 「可添加」分组错位修复：unifiedNavCatalog 改为 launcher 先 push、menu 补充，工作流/市场/模型/团队等正确归到「基础设施」组而非「其他菜单」 |
| fix | prd-admin | 「恢复默认」按钮始终可点（除非保存中），点击后写入硬编码推荐布局：智能体 + 百宝箱 + 核心基础设施（市场/知识库/网页/模型/团队），不再受 admin defaultNavOrder 影响 |
| feat | prd-admin | 新增 getHardcodedDefaultNavOrder 工具函数，作为系统推荐布局的单一来源 |
