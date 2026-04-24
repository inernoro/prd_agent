| feat | prd-api | `DailyTipTourStep` 新增 `NavigateTo?: string` 字段:每一步可独立 navigate 切路由,支持真正的跨页 Tour。`NormalizeAutoAction` / `TipUpsertRequest` 同步 |
| feat | prd-admin | `SpotlightOverlay` 在「下一步」前检测 `nextStep.navigateTo`,有则 `useNavigate(navigateTo)` 切路由再 poll selector。失败卡片上的「跳过这一步」也同样生效 |
| feat | prd-api | 大全套 `showcase-all-features` seed 扩到 **11 步跨页面 Tour**:预填百宝箱搜索 → 首页 → 海鲜市场 → 智识殿堂 → 文档空间 → 更新中心(2 步)→ 周报 → 缺陷 → 涌现 → 回首页撒花。一次验证 scroll + prefill + 跨路由 + 按钮位撒花所有能力 |
| feat | prd-api | `TipUpsertRequest.SourceType` 字段落入 Create / Update 路径,默认 `manual`;前端 `DailyTipUpsert` 同步 |
| feat | prd-admin | 小技巧管理页新增**多选 + 批量推送**:每行左侧圆形 checkbox、顶部全选 chip、选中后浮现紫色批量操作栏(选用户 / 按角色 / 全体一键推);用户下次轮询立即收到。支持一次对 N 条 tip 执行 push |
| feat | prd-admin | 新增**场景分类** `SourceType` 下拉(新功能 / 技巧 / 缺陷修复 / 新手教程 / 手建);列表每条卡片显示彩色场景 chip(带图标 Rocket/Lightbulb/Wrench/Sparkles/Pencil),取代原本单色 `order=N` 标签 |
| refactor | prd-admin | 小技巧列表重新设计为**苹果风**:卡片圆角 12 → 16、内边距 14×16、hover `translateY(-1)` 微动、chip 全部改为 pill 形(圆角 999),移除死板的 `#N` 标签(移到右上角作为 mono 小字)。选中态走 gradient + 紫色阴影 |
| docs | .claude/skills | `createzzdemo` 技能补 `navigateTo` 跨页能力说明 + SourceType 场景分类必问项 |
