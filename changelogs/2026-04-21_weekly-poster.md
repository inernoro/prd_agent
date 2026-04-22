| feat | prd-api | 新增 WeeklyPosterAnnouncement 模型与 /api/weekly-posters 接口，支持周报海报草稿/发布流 |
| feat | prd-admin | 登录后主页新增周报海报轮播弹窗（WeeklyPosterModal），末页 CTA 跳转完整周报；session 内关闭不再弹出 |
| feat | prd-admin | 百宝箱新增「周报海报编辑器」（wip 施工中），支持多页编辑、配图提示词一键复制跳转视觉创作 |
| docs | skills | weekly-update-summary 技能新增 Phase 8「海报化」+ reference/poster-pages.md 规则 |
| feat | prd-api | 周报海报新增 AI 向导后端：PosterTemplateRegistry 4 模板 + PosterAutopilotService 读数据源+结构化 JSON，新增 /autopilot /templates /pages/:order/generate-image 三个端点 |
| feat | prd-admin | 百宝箱「AI 周报海报工坊」向导页：选模板+数据源+点一次 → autopilot 自动写文字 + 并发生图 + 预览 + 发布；原编辑器移至 /weekly-poster/advanced 做高级模式 |
| docs | skills | weekly-update-summary Phase 8 重写为「引导用户去工坊」，减少技能手工调 API 的冗余步骤 |
| fix | prd-api | AppCallerRegistry 补齐 ReportAgent.WeeklyPoster 子类（Autopilot/Image 两个常量），修复「appCallerCode 未注册」错误 |
| test | prd-api | 新增 AppCallerCodeRegistryGuardTests：CI 扫描源码中所有 AppCallerCode 字面量，缺失注册即失败（彻底堵住同类 bug） |
| refactor | prd-admin | AI 周报海报工坊换皮：全页改用系统 Surface System（.surface 液态玻璃），去掉过饱和紫色渐变与强光晕，减少 AI 生成仪表盘风观感 |
| feat | prd-api | 周报海报新增 SSE 流 `/autopilot/stream` — 逐阶段推送 phase/source/model/page/done 事件，替代一口气 10s+ 的同步调用；扩展 4 种数据源（changelog / github-commits / knowledge-base / freeform）+ 新增 `/knowledge-entries` 文档选择接口 |
| feat | prd-admin | AI 海报工坊改名去「周报」绑定；向导页接入 useSseStream，生成过程实时滚动阶段文案 + 模型 chip + 页面卡逐张 fade-in 材质化，彻底消除 10s 空白等待；新增 GitHub 最近提交与知识库文档两个数据源入口 |
| fix | prd-admin | 向导预览弹窗一闪而过 bug — 重构 WeeklyPosterModal 为无状态 PosterCarousel 组件（props 驱动），去掉 store.subscribe 副作用导致的立即关闭；主页用 WeeklyPosterModal 薄封装复用 |
| fix | prd-admin | 高级编辑器页顶部加「← 返回工坊」按钮，解决从工坊跳过来回不去的问题 |
