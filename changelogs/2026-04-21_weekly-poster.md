| feat | prd-api | 新增 WeeklyPosterAnnouncement 模型与 /api/weekly-posters 接口，支持周报海报草稿/发布流 |
| feat | prd-admin | 登录后主页新增周报海报轮播弹窗（WeeklyPosterModal），末页 CTA 跳转完整周报；session 内关闭不再弹出 |
| feat | prd-admin | 百宝箱新增「周报海报编辑器」（wip 施工中），支持多页编辑、配图提示词一键复制跳转视觉创作 |
| docs | skills | weekly-update-summary 技能新增 Phase 8「海报化」+ reference/poster-pages.md 规则 |
| feat | prd-api | 周报海报新增 AI 向导后端：PosterTemplateRegistry 4 模板 + PosterAutopilotService 读数据源+结构化 JSON，新增 /autopilot /templates /pages/:order/generate-image 三个端点 |
| feat | prd-admin | 百宝箱「AI 周报海报工坊」向导页：选模板+数据源+点一次 → autopilot 自动写文字 + 并发生图 + 预览 + 发布；原编辑器移至 /weekly-poster/advanced 做高级模式 |
| docs | skills | weekly-update-summary Phase 8 重写为「引导用户去工坊」，减少技能手工调 API 的冗余步骤 |
