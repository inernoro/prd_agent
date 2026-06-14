| fix | prd-admin | 修复海鲜市场技能预览右侧 SKILL.md 失真：代码块内 Prism markdown 表格 token 类名 `table` 与 Tailwind v4 `.table{display:table}` 撞名导致每个单元格各占一行，强制代码块 token 回退 inline |
| feat | prd-admin | 技能分享公开页顶部横条新增「下载技能压缩包」按钮（免登录直下，走已有公开 zip 端点） |
| feat | prd-admin | 技能分享改为弹窗式，支持选择有效期（永久/7/30/90 天），全局单例 SkillShareDialog 由卡片与详情弹窗共用 |
| fix | prd-admin | 技能分享弹窗：生成链接期间忽略别处 open()，避免界面与复制链接对应不同技能；详情弹窗 Esc 让位给上层分享弹窗，不再一次 Esc 连关两层 |
| fix | prd-admin | 技能分享弹窗 busy 闸改为生成时同步置位（不走 effect），杜绝点击到 effect 之间的竞态窗口 |
| feat | prd-api | 「我的分享」聚合新增技能分享（marketplace_skill），跨 5 类统一管理；技能分享链接 /s/skill/{token} 可在「我的分享」查看/复制 |
| feat | prd-admin | 「我的分享」页新增「技能」分类标签与筛选 |
