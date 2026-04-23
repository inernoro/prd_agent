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
| feat | prd-api | 海报工坊真·LLM 流式：PosterAutopilotService 暴露 StreamLlmChunksAsync(IAsyncEnumerable) + ParseAccumulatedContent；Controller 在 /autopilot/stream 内逐 chunk 透传 model/chunk/thinking 事件给前端 |
| feat | prd-admin | 向导页打字机面板：订阅 chunk SSE 事件实时拼接 typingText，按钮下方渲染终端风滚动输出（mono + 字数 ticker + 闪烁光标），LLM 写文案 5-15s 期间用户能看到 AI 一字一字吐出来，彻底履行 CLAUDE.md #6「禁止空白等待」 |
| refactor | prd-api | 海报 LLM 输出改 Markdown 分段（`## Page N · 标题 · #色` + 正文 + `[IMG] prompt`）替代 JSON，对 LLM 更友好 + 可流式增量解析 + 支持 markdown 预览；ExtractClosedPagesSoFar 在每次 chunk 到达后提取新闭合 page 立即 emit，卡片逐张冒出不再等整坨完成 |
| feat | prd-admin | 预览弹窗 body 改用 MarkdownContent 组件渲染（支持 **加粗**/列表/表格/代码块），正文视觉效果升级 |
| fix | prd-admin | 向导结果区 poster.pages 访问加 `?? []` 守卫 + ResultPageCard key 降级 fallback，修复「Cannot read properties of undefined (reading 'length')」运行时错误与 React key 警告 |
| feat | prd-admin | 海报工坊服务器权威化:用户选择(templateKey/sourceType/kbEntryId/freeformContent) + 当前草稿 posterId 都写 sessionStorage,刷新页面自动从后端 getWeeklyPoster 恢复,草稿不再丢 |
| refactor | prd-admin | 海报工坊从「百宝箱」移除,改挂到「我的资源 → 海报设计」tab(资源产物的归属更合理);资源管理页新增 PosterDesignSection 列出所有海报,卡片点击回工坊继续编辑,支持撤回/删除 |
| feat | prd-admin | 「我的资源 → 海报设计」改为三栏设计器内嵌渲染：左侧海报列表/新建 modal，中间图文页编辑与上传/粘贴/AI 重生图，右侧 Markdown 文案与 CTA 自动保存；/weekly-poster 深链同步指向新设计器，旧向导保留在 /weekly-poster/wizard |
| fix | prd-admin | 登录态持久化从 sessionStorage 切到 localStorage，并增加旧登录态迁移；同一预览域名下新开标签页/重新打开后台地址不再重复登录（跨子域 SSO 仍待 CDS 支持） |
