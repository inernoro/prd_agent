# 伊利 VOC 闭环 · 债务台账

> **版本**：v1.0 | **日期**：2026-06-12 | **状态**：维护中

## 总览

当前 open: 7 / paid: 0 / 总计: 7

本台账记录 `design.voc-vertical-slice.md` 第一个垂直切片**有意未做**的部分。垂直切片只补"涌现→需求池"一环，其余靠组装现有积木；下面这些是真实缺口，不假装已有（无根之木禁令）。

## 债务列表

| ID | 严重度 | 创建日期 | 描述 | 触发条件 | 状态 | 备注 |
|----|--------|---------|------|---------|------|------|
| 2026-06-12-bi-drilldown-dashboard | high | 2026-06-12 | 配置化 BI 下钻看板（一级→四级指标→词云→原文、同款比、TOP 排行）未实现，是交付物 1 核心 | 伊利确认数据规模 + 对接方式后立项 | open | 新框架：维度引擎 + 下钻 + 情感聚合管道，工作量大，需独立 design |
| 2026-06-12-voice-sentiment-pipeline | high | 2026-06-12 | 声量/满意度批量计算 + 情感分析管道未实现，看板 KPI 现为演示态 | 接入真实评论数据源时 | open | LLM Gateway 可做分类，但缺批量+可回溯+可聚合到看板的管道 |
| 2026-06-12-rag-semantic-cluster | medium | 2026-06-12 | 海量原声语义聚类依赖 RAG/embedding，当前未实现，演示用 LLM 直接聚类 | 原声量级超过单次 LLM 上下文时 | open | codebase-snapshot 已标注 RAG 未实现，规模化必补向量层 |
| 2026-06-12-competitor-cross-matrix | medium | 2026-06-12 | 本竞品交叉矩阵（本品优劣势 × 竞品优劣势四象限）未实现 | 涌现切片验收通过、要做交付物 3 完整版时 | open | 可在涌现探索器上叠加矩阵视图，需竞品数据接入 |
| 2026-06-12-improve-project-fields | low | 2026-06-12 | 改善项目追踪字段不全（DefectProject 仅容器，缺里程碑/进度/成本/成员） | 改善追踪从演示态转真实使用时 | open | 按需补字段或新建 ImprovementProject 实体 |
| 2026-06-12-source-system-unify | low | 2026-06-12 | `Requirement.SourceSystem` 非跨流统一枚举：缺陷转需求未设该字段，前端无法据此统一筛选来源 | 前端要按来源（defect/emergence/tapd/manual）统一打标筛选时 | open | 需三步：emergence 写 "emergence" + 缺陷转需求补 "defect" + 存量回填脚本（SourceDefectId!=null→defect）。Codex PR#795 review 提出 |
| 2026-06-12-emergence-source-unique-index | medium | 2026-06-12 | adopt 幂等承重于 `Requirement.SourceEmergenceNodeId` 的 partial unique index（`partialFilterExpression` 含 `SourceEmergenceNodeId:{$type:string}` + `IsDeleted:false`，与查重同口径），需 DBA 手建（no-auto-index 规则禁止启动时自动建） | DBA 上线 adopt 端点前执行 | open | 索引条目已落 guide.mongodb-indexes.md（requirements → uniq_requirements_source_emergence_node），剩 DBA 实际执行；缺索引则并发下可能产生重复需求，漏 IsDeleted:false 则软删后无法重新流转 |

## 已还的债务（归档）

> 修复后从上面表格挪到这里，保留以便复盘

| ID | 修复 PR | 修复日期 | 备注 |
|----|---------|---------|------|
