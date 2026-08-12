# 演讲智能体 · 债务台账

> **版本**：v1.0 | **日期**：2026-07-17 | **状态**：开发中

**一句话**：演讲智能体（长文自动拆成演讲大纲）交付时主动声明的已知边界台账。
**谁该读**：接手演讲智能体的产品与工程师。
**读完能做什么**：判断某个能力是没做还是不打算做。

---

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
| 说话人逐句归属是估算 | 上游未返回原生说话人时走本地声纹兜底：**分出几个人**来自真实声学聚类（基频 / 过零率 / Goertzel 频带 + 平均链接），但**哪句话归谁**是按字数比例摊到语音段上（`LocalSpeakerDiarizer.AlignClausesToTurns`），隐含「所有人语速一致」假设；每句时间戳取的是该语音段起止，不是这句话的真实起止。已在笔记里写明来源（`> 说话人来源：local · …`）并在结果页标注，但估算本身未消除。要精确需要真正的强制对齐（forced alignment）或上游原生 diarization。 |
| 说话人来源仅三态 | 来源只区分 native / model / local 三种，且要求同一批分段来源一致才写来源行；混合来源（未来若出现分段级混合改写）会退化为不写，用户看不到任何提示。 |
| 自测路径有限 | 本次 MVP 自测路径：本地 `pnpm tsc + pnpm test navCoverage + pnpm lint`；CDS 灰度 + 真实 LLM 端到端待用户验收 | 见交付消息 |
