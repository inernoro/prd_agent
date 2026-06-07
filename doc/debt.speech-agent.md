# 演讲智能体 · 工程债务台账

> 任务交付时主动声明的"已知边界"段落必须固化到此文件（CLAUDE.md 规则 #10）。

| 项 | 说明 | 计划 |
|---|---|---|
| 知识库选文档输入 | 上传/粘贴已落地（Phase 1.5），知识库选文档通道待补 | Phase 2 |
| PDF / Word 解析 | 上传只支持 .md / .txt，PDF/Word 解析待接 attachment 服务 | Phase 2 |
| 节点视图非画布 | 当前是 depth 分列 + 列表；ReactFlow 画布手势需对齐 `gesture-unification.md` 标准 B | Phase 2 |
| 无 Run/Worker | 生成走内联 SSE，客户端断开不阻断 LLM 但前端事件会丢；server-authority 规则要求长任务走 Run/Worker | Phase 2 |
| 无配图 | 节点 `ImageAssetId` 字段已建，但 ImageGen 联动 + UI 渲染未做 | Phase 2 |
| 无演讲备注 | `SpeakerNotes` 字段已建，AppCallerCode `speech-agent.mindmap.speaker-notes::chat` 已注册但未消费 | Phase 2 |
| 节点配图 | 播放态已落地（全屏分屏+键盘），但单节点配图未做 | Phase 2 |
| 无发布到 hosted_sites | `PublishedSiteId` 字段已建，发布动作未实现 | Phase 2 |
| 白天主题适配 | 编辑器配色当前偏暗，白天模式对比度未走 `cds-theme-tokens` 规则审计 | Phase 2 |
| 节点删除/重排 | MVP 只支持编辑文字内容；增删/拖拽改顺序未做 | Phase 2 |
| 长文档 chunk | `SourceText` 入库前硬截 16K 字；超长文档需 chunk → 段级 outline → 全局 refine | Phase 2 |
| 自测路径有限 | 本次 MVP 自测路径：本地 `pnpm tsc + pnpm test navCoverage + pnpm lint`；CDS 灰度 + 真实 LLM 端到端待用户验收 | 见交付消息 |
