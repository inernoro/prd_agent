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
涌现节点（任意 Status：idea/planned/building/done）
   │ 用户点「流转需求池」，选目标 Product
   │ 注：能否 adopt 不看节点 Status，只看"该节点是否已有活跃(!IsDeleted)需求"
   ▼
POST /api/emergence/nodes/{id}/adopt  { productId }
   │  查重：按 Requirement.SourceEmergenceNodeId == 节点id 的活跃行，命中即返回既有需求
   │  insert Requirement{ Title=节点标题, Description=节点描述+GroundingContent,
   │               SourceSystem="emergence", SourceEmergenceNodeId=节点id }（唯一索引兜底并发）
   │  best-effort 回填 EmergenceNode.AdoptedRequirementId = 需求id; Status → planned
   ▼
需求池（product-agent Requirement 列表）
```

## 六、数据设计

仅两处增量字段，零破坏性变更（都可空、旧数据兼容）：

| 实体 | 新增字段 | 类型 | 说明 |
|------|---------|------|------|
| `Requirement` | `SourceEmergenceNodeId` | `string?` | 对照已有 `SourceDefectId`，记录来源涌现节点。**幂等键 + partial unique index 承重件**（见 7 节） |
| `EmergenceNode` | `AdoptedRequirementId` | `string?` | 反范化便利指针（给 UI 显示"已流转" chip 用），可由 `Requirement.SourceEmergenceNodeId` 反查重建；**非权威**，不作幂等判定 |

`Requirement.SourceSystem` 复用既有字段，emergence 流转时填 `"emergence"`。注意它当前并非跨流统一枚举（缺陷转需求未填，见 5.1）；若要作为统一来源依据，需按 5.1 的三步补丁 + 回填（已记 `debt.voc`）。

## 七、接口设计

新增一个端点，签名与既有"缺陷转需求"对齐：

```
POST /api/emergence/nodes/{nodeId}/adopt
Body: { productId: string }
鉴权：节点所属树 OwnerId == 当前用户；产品按分支校验（命中分支校 existing.ProductId，
      insert 分支校入参 productId）——详见下方编号步骤，勿只看本行摘要
幂等键：Requirement 中 SourceEmergenceNodeId == nodeId 的活跃行（!IsDeleted）
返回：ApiResponse<Requirement>
```

**核心不变量**：一个涌现节点**最多对应一条活跃（`!IsDeleted`）需求**。注意是"活跃"——既有活跃需求被软删后允许重新 adopt 生成新需求，所以不是"一个节点历史上只能流转一次"。锁放在需求的 `SourceEmergenceNodeId`（活跃唯一索引）上，不放在节点 `AdoptedRequirementId` 上：后者若先标记再 insert，insert 失败会留孤儿锁卡死；放在"真正被创建的活跃需求"上则无空窗。`AdoptedRequirementId` 仅是给 UI 的反范化指针，可懒修复，**非权威、不参与幂等判定**。

**禁止用节点 `Status` 当 adopt 守卫**：`Status`（idea/planned/building/done，无 `explored` 这个值）与"能否流转"正交。adopt 成功会把节点置 `planned`，但软删需求后必须仍能重新 adopt——若实现按 `Status` 限制（如"仅 idea 可流转"），`planned` 节点会被错误挡住，与上面的重新 adopt 路径冲突。判定唯一依据是"该节点是否已有活跃需求"（即第 2 步查重），不是 `Status`。前端按钮可禁用态同理：以"是否有活跃需求"为准（见前端段）。

**实现顺序（编号步骤为权威 SSOT，鉴权步骤已内联，照此实现即不留越权/脏写缺口）**：

1. **节点属主校验**（两分支共同前置）：读节点 → 取 `TreeId` → 校验 `EmergenceTree.OwnerId == userId`（与 `EmergenceController` 既有变更端点一致，按树属主）。不通过 → 404/403。先于一切查重/写入，禁止凭猜测的私有 node id 流转/探测他人节点。
2. **查重**：`Requirements.Find(SourceEmergenceNodeId == nodeId && !IsDeleted)`。
3. **命中分支**（查到活跃需求）：产品侧鉴权两道都过才返回——①`AdminPermissionCatalog.ProductAgentUse` 权限闸（端点在 emergence 路由下不自动生效，必须显式校验，理由见下方说明）；②`FindAccessibleProductAsync(existing.ProductId, userId)`，校的是**既有需求自身的 `existing.ProductId`**、**不是**入参 productId——命中分支忽略入参 productId，若只校入参，用户对产品 A 失权后塞一个能访问的产品 B 仍能取回 A 的需求（IDOR）。两道都过 → 返回既有需求（忽略入参 productId），结束；任一不过 → 403/conflict，不返回。
4. **insert 分支**（未查到）：产品侧鉴权两道都过才创建——①`AdminPermissionCatalog.ProductAgentUse` 权限闸；②`FindAccessibleProductAsync(productId, userId)`，校**入参 `productId`**（需求要落进这个产品）。任一不过 → 404/403；都过才创建需求。**创建必须复用 product-agent 的需求创建路径，不得裸 insert** —— `ProductAgentController.CreateRequirement` / `ConvertDefectToRequirementInternalAsync` 除了写字段还做三件事：生成 `RequirementNo`（编号）、绑定默认 `WorkflowDefId` + 初始 `CurrentState`、刷新 `Product.RequirementCount`。裸 insert 会造出空编号/空状态 + 产品计数失准的脏需求。落地做法：把缺陷转需求里那段创建逻辑抽成一个共享内部方法（如 `CreateRequirementInternalAsync(productId, title, description, source)`），adopt 与缺陷转需求都调它，仅 source 来源字段不同（adopt 填 `SourceEmergenceNodeId` + `SourceSystem="emergence"`，缺陷填 `SourceDefectId`）。
5. **并发兜底**：`Requirement.SourceEmergenceNodeId` 上有 **partial unique index，过滤 = 非空 且 `IsDeleted: false`**（只对活跃且有来源节点的行唯一）。两请求同时过了第 2 步查重时，第二条 insert 被唯一约束拒绝（duplicate key）→ 捕获后回第 2 步查重、走命中分支返回，绝不产生两条。
6. **best-effort 回填节点**：insert 成功后 `UpdateOne(node, { AdoptedRequirementId: reqId, Status: planned })`。失败也无害——需求已建成且经 `SourceEmergenceNodeId` 可反查，下次读节点或下次 adopt 时懒修复。任何步骤失败重试都收敛到同一条活跃需求，不卡死、不劈裂。

**（说明：为什么第 3/4 步要显式校验 `ProductAgentUse` 权限闸）**：adopt 挂在 `/api/emergence/*` 下，全局中间件只会要求该路由的 `emergence-agent.use`，**不会**触发保护 `ProductAgentController` 的 `[AdminController("product-agent", AdminPermissionCatalog.ProductAgentUse)]` 权限闸。所以不能只靠 `FindAccessibleProductAsync`（产品成员/归属）——否则"有涌现权限 + 是产品成员但无 product-agent 权限"的角色能绕过正常产品端点的权限闸、借 adopt 创建/读取需求。这就是第 3/4 步把 `ProductAgentUse` 列为产品侧第一道校验的原因。

**软删除与唯一索引同口径（硬要求）**：查重过滤 `!IsDeleted`，索引 `partialFilterExpression` 也必须含 `IsDeleted: false`。若索引漏了它：需求软删后查重查不到活跃行，但索引里软删行还占位，重新 adopt 的 insert 撞 duplicate-key 却无活跃行可返回 → 节点永久无法再流转。同口径后：软删 → 索引腾位 → 重新 adopt 正常 insert 新活跃需求，核心不变量"一节点一活跃需求"成立。

唯一索引是承重件（非可选防御）。按 `no-auto-index.md`，索引由 DBA 手动建——已作为实现前置条件登记在 `doc/guide.mongodb-indexes.md`（`requirements` → `uniq_requirements_source_emergence_node`，上线 adopt 端点前必须先执行）。

**前端**：涌现节点卡片底部"流转需求池"按钮。**"已流转"状态必须取权威源 —— 由"是否存在 `SourceEmergenceNodeId == 节点id && !IsDeleted` 的需求"派生，不能用节点的 `AdoptedRequirementId` 判定**。原因：`AdoptedRequirementId` 是 best-effort 缓存（第 6 步回填可能失败、或软删后变陈旧），会两头出错——insert 成功但回填失败时活跃需求已存在、指针却为空，卡片错显可点按钮；既有需求软删后指针仍在、却已可重新 adopt，卡片错显 chip 禁用按钮。正解：后端在节点列表/详情响应里**直接附带由活跃查重算出的派生字段**（避免前端二次查询），`AdoptedRequirementId` 只作内部缓存、不进前端判定。

**但这些派生字段必须按权限过滤，不能裸塞进节点响应（否则泄漏私有需求标识）**：`EmergenceController.GetTree`（`EmergenceController.cs:118`）允许 `t.OwnerId == userId || t.IsPublic` 公开读——任何人都能看公开涌现树的节点。若把 `requirementId/requirementNo` 无差别塞进节点 DTO，浏览公开树、但无 `ProductAgentUse` / 无该产品访问权的人就能看到私有产品的需求编号。规则：
- `requirementId` / `requirementNo`（产品派生标识）**只对"能访问该需求所在产品"的调用方返回**（`ProductAgentUse` 权限闸 + `FindAccessibleProductAsync(requirement.ProductId, userId)` 都过），其余调用方 DTO 里**省略**这两个字段。
- `hasActiveRequirement`（裸布尔，不含任何产品标识）可对所有可读该树的人返回——它只表达"这个节点已被流转过"，不泄漏产品/需求身份。
- 前端：有权 → `hasActiveRequirement && requirementNo` 显示可点 chip 跳 product-agent；无权但 `hasActiveRequirement` → 显示不可点的"已流转"灰标（无链接、无编号）；`false` → 显示可点"流转需求池"按钮。

复用现有 `apiClient.apiRequest`（传原始对象，不二次 stringify）。

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
| adopt 跨权限域越权（IDOR） | 中 | 节点按树 `OwnerId == userId`；产品侧 = `ProductAgentUse` 权限闸 + `FindAccessibleProductAsync`（端点在 emergence 路由下，product 权限闸不自动生效，必须显式校验）；校验对象**按分支取**——insert 校入参 productId、命中校 `existing.ProductId`（命中分支忽略入参，只校入参则失权后可借他产品取回需求）。先于返回/insert（见 7 节） |
| 公开树节点响应泄漏私有需求标识 | 中 | `GetTree` 允许公开树人人读；节点响应里 `requirementId/requirementNo` 必须按产品访问权过滤（无权则省略），仅 `hasActiveRequirement` 裸布尔对所有可读者开放（见 7 节前端段） |
