# 伊利 VOC 用户原声闭环 · 设计

> **版本**：v1.0 | **日期**：2026-06-12 | **状态**：草案

## 一、管理摘要

伊利 VOC（用户原声）项目要的不是三个孤立功能，而是一条从"消费者评论"到"产品需求"的完整闭环：**数据监测 → 智能预警 → 根因诊断 → 改善追踪 → 创新洞察 → 业务需求池**。

对我们的关键判断：这条链的终点——"洞察一键流转到业务需求池、主动挖掘需求而非被动承接"——恰好就是 PRD Agent 存在的理由。把这条链拆开看，**约 80% 的环节已有现成模块**（缺陷管理 = 工单、工作流 = 闭环、涌现探索器 = 洞察、LLM Gateway = 诊断、product-agent Requirement = 需求池），真正缺的只有两块：链路最后那"一公里"的**涌现 → 需求池流转**，以及交付物一的**配置化 BI 下钻看板**。

本设计聚焦"用现有积木拼通端到端、补齐流转那一环"，作为伊利方案的第一个可演示垂直切片。BI 看板因工作量大且依赖伊利数据规模与对接方式，单独列为待立项项与技术债，不在本期实现。

**一句话**：本期只写一个新功能（涌现节点"流转需求池"），其余靠组装；先证明平台能拼出 VOC 闭环，再决定是否投入重型 BI 看板。

## 二、产品定位

| 维度 | 说明 |
|------|------|
| 解决谁的问题 | 伊利各事业部：从海量用户原声里发现问题、追踪改善、挖掘创新机会 |
| 对我们的价值 | 第一个真实企业级垂直锚点，验证"平台积木组装行业方案"的能力；同时倒逼补齐"洞察→需求"这一普适能力（不只伊利用得到） |
| 边界 | 本切片不做重型 BI 看板、不做 RAG 向量检索、不对接伊利存量工单系统（需对方提供 API） |
| 北极星对齐 | "主动挖掘需求而非被动承接"是 PRD Agent 的产品愿景，VOC 是它的天然上游场景 |

## 三、用户场景（端到端故事）

以"安慕希黄桃味结块"为例，走通六步：

1. **监测**：事业部看板显示某 SKU 负面声量曲线突增 +213%，触达自定义预警阈值。
2. **预警**：系统自动建一张工单，把关联工厂、生产批次、集中区域、渠道数据挂载上去。
3. **诊断**：LLM 流式生成结构化根因报告（时间聚集 + 区域聚集 + 文本聚类 → 疑似批次工艺 + 高温运输叠加），完成后跨部门自动派单。
4. **改善追踪**：自动立项一个改善项目，工作流每日 cron 复测声量对比，里程碑推进到"声量复测达标"才算结项——补齐"预警后效果追踪"的闭环。
5. **洞察**：涌现探索器基于全量原声做关键词聚类 + 本竞品交叉矩阵，浮现出机会概念（改进机会 / 产品机会 / 营销亮点），每个都带原文证据链。
6. **流转**：用户在洞察节点点"流转需求池"，洞察当场变成一条业务需求（带来源标记与证据回溯），进入产品需求评审流程。

第 6 步那一下，是"被动承接需求"到"主动挖掘需求"的分界点，也是本期唯一的新代码。

## 四、核心能力与现状映射

诚实标注每一环用的是现成模块、还是缺口（遵循无根之木禁令——不假装有不存在的能力）：

| 闭环环节 | 伊利交付物 | 我们的现有积木 | 命中度 | 本期动作 |
|----------|-----------|---------------|--------|----------|
| 数据监测看板 | 交付物 1 | admin 仪表盘（无通用下钻 BI） | 低 | 不做，列入 debt + 待立项 |
| 智能预警工单 | 交付物 2 | 缺陷管理 Agent（工单/分享/修复报告/验收） | 高 | 直接复用，演示形态 |
| 自动诊断报告 | 交付物 2 | LLM Gateway（SSE 流式 + 模型可见） | 高 | 复用 |
| 跨部门派发 | 交付物 2 | 工作流 Agent（事件触发 + 派发） | 高 | 复用 |
| 改善项目追踪 | 交付物 1/2 | DefectProject（仅容器，缺里程碑/进度） | 中 | 字段待补，本期演示态 |
| 效果复测闭环 | 交付物 2 | 工作流 cron + llm-analyzer 节点 | 中高 | 复用 |
| 关键词聚类/机会概念 | 交付物 3 | 涌现探索器（种子→探索→涌现） | 中高 | 复用 |
| 本竞品交叉矩阵 | 交付物 3 | 无 | 缺 | 列入 debt，v2 补 |
| 洞察→需求池 | 交付物 3 | product-agent Requirement（有 SourceDefectId 先例，无涌现来源） | 缺最后一环 | **本期唯一新代码** |
| 常态化洞察自动输入 | 交付物 3 | 工作流 cron + LLM | 中 | 复用，演示态 |
| 海量数据语义检索 | 交付物 3 | RAG/embedding 未实现 | 缺 | 列入 debt |

## 五、架构设计

### 5.1 不新建"需求池"实体——复用 product-agent

系统里 `Requirement` 实体已经具备需求池所需的一切：编号、分级、状态机（绑 WorkflowDefinition）、负责人、来源溯源字段。更关键的是它已有 `SourceDefectId` + `ConvertDefectToRequirement` 端点——"缺陷转需求"已经跑通。

**"涌现转需求"是它的同构兄弟**：缺陷转需求记 `SourceDefectId`，涌现转需求记 `SourceEmergenceNodeId`，共用幂等检查与编号生成逻辑。这样需求池天然统一——无论需求来自缺陷、涌现、还是外部 TAPD 导入，都落在同一张 `requirements` 表，走同一套评审流程。

**关于来源标记 `SourceSystem`（一致性前置条件，勿想当然）**：现状不对称——缺陷转需求（`ConvertDefectToRequirement` ~`ProductAgentController.cs:2055`）当前**只设 `SourceDefectId`、并未设 `SourceSystem`**；TAPD 导入才会填 `SourceSystem="tapd"`。因此 `SourceSystem` **当前并非已跨流共享的统一来源枚举**，不能直接拿来当前端按来源筛选/打标的依据。若本期要把"来源"做成统一枚举（defect/emergence/tapd/manual），必须配套三件事，缺一即口径不一致：(1) emergence 转需求时显式写 `SourceSystem="emergence"`；(2) 给既有缺陷转需求补一行 `SourceSystem="defect"`；(3) 对存量 `requirements` 跑一次性回填（`SourceDefectId != null → "defect"`，已有 `SourceSystem` 的保留，其余 `"manual"`）。回填脚本与"统一来源枚举"已列入 `debt.voc`，本期不强制——前端若暂不依赖该枚举，可仅靠 `SourceDefectId` / `SourceEmergenceNodeId` 两个具体来源 id 判定，避免引入半成品枚举。

### 5.2 反向可回溯（双向链）

涌现节点本就要求"有根"（`GroundingContent` / `GroundingRef` 锚定到原文证据）。流转后：

- 正向：`EmergenceNode.AdoptedRequirementId` → 指向生成的需求
- 反向：`Requirement.SourceEmergenceNodeId` → 指回涌现节点 → 再顺 Grounding 回溯到原文评论

于是从"一条业务需求"可以一路倒查到"哪些消费者原声催生了它"，满足伊利对"证据链"的要求。

### 5.3 数据流

```
涌现节点(idea/explored)
   │ 用户点「流转需求池」，选目标 Product
   ▼
POST /api/emergence/nodes/{id}/adopt  { productId }
   │  幂等：已 adopt 直接返回既有需求
   │  Requirement{ Title=节点标题, Description=节点描述+GroundingContent,
   │               SourceSystem="emergence", SourceEmergenceNodeId=节点id }
   │  EmergenceNode.AdoptedRequirementId = 需求id; Status → planned
   ▼
需求池（product-agent Requirement 列表）
```

## 六、数据设计

仅两处增量字段，零破坏性变更（都可空、旧数据兼容）：

| 实体 | 新增字段 | 类型 | 说明 |
|------|---------|------|------|
| `Requirement` | `SourceEmergenceNodeId` | `string?` | 对照已有 `SourceDefectId`，记录来源涌现节点 |
| `EmergenceNode` | `AdoptedRequirementId` | `string?` | 回填生成的需求 id；非空即"已流转" |

`Requirement.SourceSystem` 复用既有字段，emergence 流转时填 `"emergence"`。注意它当前并非跨流统一枚举（缺陷转需求未填，见 5.1）；若要作为统一来源依据，需按 5.1 的三步补丁 + 回填（已记 `debt.voc`）。

## 七、接口设计

新增一个端点，签名与既有"缺陷转需求"对齐：

```
POST /api/emergence/nodes/{nodeId}/adopt
Body: { productId: string }
幂等：节点 AdoptedRequirementId 已非空 → 直接返回那条既有需求（忽略本次 productId）
返回：ApiResponse<Requirement>
```

**幂等语义（一节点只流转一次）**：与缺陷转需求不同——缺陷天然归属一个产品（productId 固定在缺陷上），而涌现节点是产品无关的，productId 由调用方在 adopt 时传入。为避免"同一节点用不同 productId 重复调用却各返回/各新建需求"的歧义，幂等**以节点自身的流转状态为准**：`AdoptedRequirementId` 一旦写入即锁定，后续任何 productId 的重复调用都返回首次生成的那条需求、不再新建（与单值 `AdoptedRequirementId` 字段语义一致）。若产品后续需要改挂，走需求的正常"移动产品"操作，而非重复 adopt。判定不查 `SourceEmergenceNodeId`（那是给需求侧反查溯源用的），直接读节点的 `AdoptedRequirementId`，省一次查询。

前端：涌现节点卡片底部新增"流转需求池"按钮（未 adopt 时可点）；已流转节点显示需求编号 chip，点击跳转 product-agent 对应需求。复用现有 `apiClient.apiRequest`（传原始对象，不二次 stringify）。

## 八、关联设计文档

- `design.product-agent`：需求/版本/功能/缺陷实体与状态机，本设计复用其 Requirement
- `design.defect-agent`：工单形态参考
- `design.workflow-engine`：cron 复测与跨部门派发
- `doc/debt.voc.md`：本期未做的 BI 看板、本竞品矩阵、RAG 检索、ETL 接入

## 九、风险与边界

| 风险 | 等级 | 说明 / 缓解 |
|------|------|------|
| BI 下钻看板工作量大 | 高 | 是新框架（维度引擎 + 下钻到词云/原文 + 情感聚合管道），单独立项；拿到伊利数据规模前不 grinding |
| 海量原声语义聚类需 RAG | 中 | 现状 embedding 未实现，演示用 LLM 直接聚类，规模化需补向量层（记 debt） |
| 对接伊利存量工单系统 | 中 | 需对方提供 API 与资料，属外部依赖，不可自产，明确为前置条件 |
| 改善项目追踪字段不全 | 低 | DefectProject 当前仅容器，里程碑/进度/成本为演示态，后续按需补字段 |
| 需求池来源多样导致口径混乱 | 低 | 统一 `SourceSystem` 枚举（defect/emergence/tapd/manual），前端按来源打标 |
