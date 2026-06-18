---
type: debt
title: 产品管理智能体工程债务台账
status: active
updated: 2026-06-10
---

# 产品管理智能体（product-agent）债务台账

记录已知边界、TODO 留尾与后续可补项。P0 交付时的"已知边界"固化于此，避免下一个 session 失忆。

## 进度

- P0（地基）：已交付（commit 0524446）。
- P1（关系与追溯）：已交付——版本↔需求/功能连边 UI、需求↔客户/版本连边、缺陷追溯、知识库 find-or-create 挂载。
- P2（图谱/升级/看板/权限）：已交付——知识图谱可视化（ReactFlow）、大版本升级申请可配置表单 + 状态流转、需求分级看板、知识库产品成员访问授权。

- P2-2（页面设计重构）：管理层总览左导航 shell + 仪表盘 + 跨产品表（已交付）；单产品视图改左导航 + 产品仪表盘（已交付）；全局设置：表单模板 + 流程模板可视化编辑器（已交付，全局默认 + 产品覆盖）。

## 已知边界

| # | 边界 | 说明 | 状态 |
|---|------|------|------|
| 1 | ~~关系连边只能填 id 数组~~ | 已做连边 UI | P1 已解决 |
| 2 | ~~缺陷追溯未打通~~ | DefectReport.Traced* + trace/untrace/列出 + 前端选择器 | P1 已解决 |
| 3 | ~~知识库未挂载~~ | find-or-create + 嵌入 DocumentStoreBrowser | P1 已解决 |
| 3b | ~~产品库非 owner 成员访问未授权~~ | DocumentStoreController 加 IsProductKnowledgeMemberAsync（产品 owner/成员可读写） | P2 已解决 |
| 4 | ~~知识图谱未实现~~ | ProductGraphCanvas（ReactFlow，列布局 + 类型着色 + 统一手势） | P2 已解决 |
| 5 | ~~大版本升级申请未实现~~ | VersionUpgradeRequest + CRUD + 状态流转 + 前端 tab | P2 已解决 |
| 8 | ~~看板视图未实现~~ | 需求分级看板（P0-P3 分列） | P2 已解决 |
| 6 | ~~表单/流程无可视化编辑器~~ | 全局设置已提供表单模板 + 流程模板可视化编辑器（全局默认 + 产品覆盖） | P2 已解决 |
| 7 | ~~详情页字段未按表单模板动态渲染~~ | 新建/详情页按生效模板动态渲染 FormData 字段；对象绑定流程后显示状态 + 流转按钮(WorkflowBar) | 已解决 |
| 8b | 图谱布局为简单列布局 | 未用 dagre 自动布局；节点多时同列堆叠较长，可后续接 autoLayout | 后续(小) |
| 11 | ~~跨产品总览图缺失~~ | 总览「图谱」已提供公司级产品→版本发布地图(ReactFlow,产品节点可下钻) | 已解决 |
| 12 | ~~产品内不能新建缺陷~~ | 产品缺陷 tab 可新建缺陷(写 defect_reports + 自动追溯产品) | 已解决 |
| 13 | ~~版本无流转/动态表单~~ | 版本自动绑定默认流程/模板，版本关系弹层显示流转条 + 动态字段 | 已解决 |
| 9 | 后端未本地编译验证 | 沙箱无 dotnet SDK，依赖 push 后 CDS 自动部署验证编译 | 持续 |
| 10 | ~~看板不可拖拽改状态~~ | 需求看板在有流程时按状态分列，支持拖拽卡片走合法流转改 CurrentState；无流程回退分级看板 | 已解决 |

## 索引登记需求（DBA）

新增集合的索引建议（按 `.claude/rules/no-auto-index.md`，应用不自动建，登记给 DBA，见 `doc/guide.mongodb-indexes.md`）：

- `products`：`{ OwnerId:1, IsDeleted:1, UpdatedAt:-1 }`、`{ MemberIds:1 }`
- `product_versions`：`{ ProductId:1, IsDeleted:1 }`
- `requirements`：`{ ProductId:1, IsDeleted:1 }`、`{ VersionIds:1 }`、`{ CustomerIds:1 }`
- `features`：`{ ProductId:1, IsDeleted:1 }`
- `feature_versions`：`{ ProductId:1, FeatureId:1 }`、`{ VersionId:1 }`
- `customers`：`{ ProductId:1, IsDeleted:1 }`
- `product_form_templates`：`{ EntityType:1, ProductId:1, IsDeleted:1 }`
- `product_workflow_definitions`：`{ EntityType:1, ProductId:1, IsDeleted:1 }`

## P0-P3 + P1 增量进度（2026-06-03）

P0/P1/P2/P3 四阶段研发全生命周期能力已交付（流转/处理人/缺陷转需求/评论时间线/通知/看板/SLA），另补齐 P0 三项（RTM 矩阵、富文本 XSS 净化、需求/功能父子层级）与 P1 两项（全局搜索、批量操作）。

| # | 能力 | 状态 |
|---|------|------|
| 14 | 默认流程开箱即用 + 处理人一等公民 + 我负责的 | P0 已交付 |
| 15 | 缺陷转需求 + SourceDefectId 溯源 | P1 已交付 |
| 16 | 评论 + 活动时间线(product_item_activities) + admin_notifications 通知 | P2 已交付 |
| 17 | 看板拖拽流转 + SLA(StateEnteredAt/SlaHours) + 流转自动认领(AutoAssignToActor) | P3 已交付 |
| 18 | RTM 需求可追溯矩阵(products/{id}/rtm) | 已交付 |
| 19 | 富文本渲染 XSS 净化(sanitizeHtml) | 已交付 |
| 20 | 需求/功能父子层级 UI(ParentId 编辑 + 列表树形缩进) | 已交付 |
| 21 | 全局搜索(search?keyword=，跨产品/需求/功能/客户/缺陷) | 已交付 |
| 22 | 批量操作(items/batch，批量删除/指派/改分级) | 已交付 |

## 仍未实现（按优先级，后续可补）

| 能力 | 优先级 | 说明 / 未做原因 |
|------|--------|----------------|
| ~~知识库 MRD/SRS/PRD 分型~~ | 已解决(2026-06-06) | DocumentStoreBrowser 加可选 `categories` prop：分类以**文档标签**实现，左侧顶部分类筛选 chips(含计数) + 快速新建标准文档按钮(MRD/SRS/PRD/设计稿/会议纪要/测试用例)。`addDocumentEntry` 已支持 title/tags/content（旧记载"无建条目 API"已过时）。不传 categories 时行为不变，未污染共享组件/后端 schema。后续若要更强的"类型即一等公民"(跨库统计/强约束)，仍可演进为 DocumentStore.docType 字段。 |
| 报表深度(燃尽图/迭代速度/版本进度) | P2 | 总览现为计数+饼图/柱图/漏斗；需基于状态流转历史(已有 product_item_activities 时间线可作数据源)算 burndown/velocity。 |
| 看板 WIP 限制 + 泳道 | P2 | 每列在制上限告警 + 按处理人/分级分泳道。 |
| 导入导出(Excel/CSV) | P2 | 需求批量导入 + 导出归档。 |
| @ 内联弹层 | P3 | 现为「选人 chips」，可升级为编辑器内 @ 触发浮窗。 |
| 图谱 dagre 自动布局 | P3 | 现为简单列布局(债务 8b)，节点多时堆叠，可接 dagre/ELK。 |

## P2 增量进度（2026-06-03 续）

| # | 能力 | 状态 |
|---|------|------|
| 23 | 报表深度(版本进度+总体进度+迭代速度，products/{id}/analytics) | P2 已交付 |
| 24 | 看板 WIP 上限(列头告警) + 泳道(无/按处理人/按分级) | P2 已交付 |
| 25 | 需求 CSV 导入/导出 | P2 已交付 |

剩余仅 P3 锦上添花：@ 内联弹层、图谱 dagre 自动布局（功能 CSV 导入未做，需要时仿需求 import 端点即可）。

## 版本独立详情页 + 知识库分类（2026-06-06）

版本详情从弹窗改为独立详情页（route `/product-agent/p/:productId/version/:id`，复用 ProductObjectDetailPage 的 DetailScaffold）：版本描述(富文本+默认模板)、内联勾选关联需求/纳入功能(即勾即存)、生命周期/大版本/父版本编辑、工作流流转、动态时间线、版本知识库入口。后端 ProductVersion 字段与 UpdateVersion 端点原已齐备，纯前端改造。知识库优化见上方"知识库 MRD/SRS/PRD 分型已解决"行。

### 已知边界

| # | 边界 | 说明 | 状态 |
|---|------|------|------|
| 29 | VersionRelationModal 成为死代码 | 版本改详情页后 `ProductRelationModals.VersionRelationModal` 不再被引用（仍导出）。为控本次改动范围未删除，后续 `/hygiene` 可清理 | 后续(小) |
| 30 | 分类筛选与文件夹/搜索叠加 | 知识库分类按标签过滤，文件夹始终保留；选中被过滤掉的条目时内容区可能空白(切分类即可)。搜索走 DocBrowser 独立结果，不受分类过滤影响 | 设计如此 |

## 团队成员管理（2026-06-06）

单产品视图新增「团队」tab：成员列表（负责人/产品管理员/成员三级角色）、增删成员、指派/撤销产品管理员。后端 `Product.AdminIds` 字段 + 4 个成员端点（list/add/remove/role）。分权：仅 MAP 管理员/负责人可指派产品管理员；产品管理员可增删普通成员。MAP 管理员（系统 admin 默认含全部权限）进任意产品即可指派该产品的产品管理员，入口统一。

### 已知边界

| # | 边界 | 说明 | 状态 |
|---|------|------|------|
| 26 | 成员档案为扁平 id 列表 | `Product.MemberIds/AdminIds` 仅存 UserId，无职位/加入时间/备注；如需更丰富成员档案（仿 ReportTeamMember），后续可升级为独立集合 `product_team_members`，但需迁移现有 MemberIds + 改全部 60+ 访问点，按需再做 | 后续(中) |
| 27 | 选人未过滤已有成员 | 添加成员的 UserSearchSelect 未排除已在列表的用户；重复添加后端 `$addToSet` 幂等无害，仅 UX 小瑕 | 后续(小) |
| 28 | AdminIds 无索引 | 登记给 DBA：`products` 可加 `{ AdminIds:1 }`（按 no-auto-index 规则不自动建） | DBA |

## 客户全局化 + 需求AI填充 + 工作台（2026-06-06）

四块交付：客户全局化、需求 AI 智能填充(SSE)、单产品工作台(我的待办)、导航重排。

### 已知边界

| # | 边界 | 说明 | 状态 |
|---|------|------|------|
| 31 | Customer.ProductId 遗留 | 客户已全局化，旧数据仍带 ProductId(不再使用)；未做数据回填脚本(无害,字段忽略) | 后续(小) |
| 32 | 旧 products/{id}/customers 端点已移除 | 客户 CRUD 全改全局 /customers；如有外部脚本调旧路由需改 | 已切换 |
| 33 | AI 填充为整段结果回填 | LLM 输出完整 JSON 后一次性回填(typing 仅作可视化)，非逐字段增量落位；字段多时等待较久但有流式动效 | 设计如此 |
| 34 | 工作台待办无 SLA 高亮 | slaHours 在工作流状态上，前端列表未拉工作流，故未做超时置顶；后续可加 | 后续(小) |
| 35 | 工作台缺陷待办为产品级 | TracedDefect 无处理人字段，按"未关闭状态"纳入(团队级,非严格我个人) | 数据所限 |

## 知识库重构（2026-06-10）

三期交付：4-Tab 知识模块（知识列表/分类/文件夹/标签管理）+ 独立知识详情页 + 版本知识调取（versionIds N:N）+ 总览跨产品聚合列表 + 旧版本库懒迁移。

### 已知边界

| # | 边界 | 说明 | 状态 |
|---|------|------|------|
| 36 | 旧版本库迁移不搬运分享链接/同步日志 | 迁移只改条目 StoreId+VersionIds 并删空版本库；若旧版本库存在整库分享链或订阅日志将悬挂（版本库基本无此类数据） | 后续(小) |
| 37 | 总览三个管理 Tab 不提供 | 聚合层无单一 store 落点，分类/文件夹/标签治理进具体产品库（用户已确认取舍） | 设计如此 |
| 38 | 详情页标签编辑走 prompt 逗号输入 | 未做 chips 编辑器；标签治理在「标签管理」tab 兜底 | 后续(小) |
| 39 | 文件夹管理不支持移动文档进出文件夹 | 仅建/改名/删（删级联）；列表视图弱化文件夹概念，需要时再补移动 | 后续(小) |
| 40 | 知识列表全文搜索未先重建 ContentIndex | 搜索带 searchContent=true 但不调 rebuild-content-index（旧 Browser 搜索时会调）；缺索引的旧条目可能搜不到正文 | 后续(小) |
| 41 | document-store 独立页仍用旧 DocumentStoreBrowser | 本次重构仅产品智能体范围；个人知识库页交互未动（共享组件未删） | 设计如此 |

## 改名 + 设置重整 + 客户拆分 + 营销问策（2026-06-15）

四项：①「产品管理智能体/项目管理智能体」改名「产品管理/项目管理」；②「应用」并入「设置」为七分类设置中心（ProductSettingsHub）+ 新增优先级/严重程度等级目录；③ 客户拆为 客户信息/动态跟进/营销问策 三 Tab；④ 营销问策（AI 评估 + 4 模版 HTML 报告 + 分享/网页托管 + 问策知识库）。

### 已知边界

| # | 边界 | 说明 | 状态 |
|---|------|------|------|
| 42 | 优先级/严重程度等级目录未接入新建表单 | ProductGradeOption 仅做可配置目录与管理 UI，尚未替换/补充需求/功能/缺陷新建时的 P0-P3 分级选择 | 后续 |
| 43 | 设置「权限」仅骨架 | 按角色分配各页面权限的细粒度矩阵未做，页面访问沿用 product-agent.use/manage/admin 三级 | 后续 |
| 44 | 新客户列表去掉批量多选/导出 | master-detail 改版后列表为简表，旧的多选导出未保留 | 后续(小) |
| 45 | 营销问策知识库为截断文本上下文 | 每篇取前 4000 字喂 LLM，未做 embedding/RAG；知识库管理走「知识库」页的「问策知识库」文档空间 | 设计如此 |
| 46 | 问策报告读写为登录门 | 沿用客户模块鉴权，未加 per-report owner 限制；share/delete 如需收紧可补 owner/manage 判定 | 后续(小) |
| 47 | 后端未本地编译 | 本环境无 dotnet SDK，3 段 C# 经逐行对照现有写法核对，编译验证依赖 push 后 CDS 远端构建 | 待 CDS 验证 |
