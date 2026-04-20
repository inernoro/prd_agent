| feat | prd-api | 新增海鲜市场「技能」板块后端：MarketplaceSkill Model + marketplace_skills 集合 + MarketplaceSkillsController（zip 上传/列表/标签/下载/收藏/删除），SKILL.md 自动走 LLM 生成 30 字摘要 |
| feat | prd-admin | 海鲜市场新增「技能」Tab：卡片式海报预览 + 按标签筛选 + 上传技能弹窗（zip 拖拽 + 标题/详情/emoji/标签，全部可空走兜底） |
| feat | prd-admin | 自定义 → 资源管理 新增「海鲜市场背景」Tab，可上传整页大气海报（默认深海蓝渐变兜底） |
| feat | prd-api | 海鲜市场新增 `GET /api/marketplace/skills/favorites` 端点，返回当前用户收藏的技能列表 |
| feat | prd-admin | 我的空间 banner 下新增「我收藏的技能」区块：一键下载 / 取消收藏 / 跳去海鲜市场 |
| refactor | prd-admin | 用户菜单：把「我的空间」上移到顶部入口，删除原「账户管理」入口；SettingsPage 新增「账户管理」Tab 承载头像替换与账户信息 |
