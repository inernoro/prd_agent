---
type: design
title: 产品管理智能体设计文档
status: draft
updated: 2026-06-02
---

# 产品管理智能体（product-agent）设计文档

## 一、管理摘要

产品管理智能体把研发的核心对象——产品、版本、需求、功能、缺陷、客户、知识库——用一张关系网串起来，能像 TAPD 一样做版本化管理、分级追溯与流程流转，并能把这些关系可视化成知识图谱。它解决的是"需求从哪来（客户）、归到哪个版本、落成哪些功能、被哪些缺陷追溯、沉淀进哪个知识库"这条研发主线在系统里没有载体的问题。

定位上它与已有的项目管理智能体（pm-agent）是两条不同的轴：pm-agent 管"临时性项目 + PMO 奖金评价"，product-agent 管"持续演进的产品 + 版本迭代"。缺陷不重建，复用缺陷管理智能体（defect-agent）只做追溯引用；知识库不重建，复用文档空间（DocumentStore）挂载。本质上它是把 `spec.srs.md` 附录D 的需求可追溯矩阵（RTM）从文档方法论做成可操作产品。

## 二、产品定位与边界

| 维度 | product-agent（本设计） | pm-agent（已存在） |
|------|------------------------|--------------------|
| 管理对象 | 持续演进的产品 | 临时性项目 |
| 核心轴 | 版本迭代 + 需求/功能/缺陷追溯 | 任务看板 + 干系人 NPSS 评价 + 奖金 |
| 关系网 | 产品-版本-需求-功能-缺陷-客户-知识库 | 项目-任务-干系人 |

复用而非重建：缺陷复用 defect-agent（持 requirementId/versionId 追溯引用）；知识库复用 DocumentStore（产品挂整体知识库、版本挂版本知识库含 MRD/SRS/PRD）；知识图谱画布复用涌现探索器的 ReactFlow 框架。

## 三、用户场景

- 产品经理建产品 → 拉版本 → 在版本下登记需求并分级 → 需求关联提出它的客户 → 需求落成功能 → 功能随版本演进（功能版本化）。
- 测试发现缺陷 → 缺陷追溯到具体需求/版本 → 在图谱里一眼看清影响面。
- 大版本升级 → 发起可配置的升级申请表单（关联需求-功能-知识，P2）。
- 任意对象都能套用自定义表单模板、走可配置的状态流转（参考 TAPD）。

## 四、核心能力

1. 五类核心对象 CRUD：产品 / 版本 / 需求 / 功能（含功能版本化 FeatureVersion）/ 客户。
2. 关系串联：版本关联需求与功能版本、需求连客户、功能落需求、缺陷追溯需求（追溯引用在缺陷侧）。
3. 通用自定义表单引擎：一套模板服务六类对象，字段类型覆盖 text/textarea/number/select/multiselect/radio/checkbox/date/datetime/user/relation/richtext/file。
4. 通用状态机 / 流程引擎：状态 + 流转边（from→to、触发动作、允许角色、是否需备注），替代缺陷那种硬编码 switch；统一 `/transition` 端点查表校验。
5. 分级：产品分级（核心/重要/普通/实验）、需求/功能/缺陷统一分级（P0-P3）。
6. 知识图谱可视化（P2）：对象为节点、关系为边，复用 ReactFlow 画布。

## 五、架构与数据设计

新增 8 个 MongoDB 集合：`products` / `product_versions` / `requirements` / `features` / `feature_versions` / `customers` / `product_form_templates` / `product_workflow_definitions`。

后端单一 Controller `ProductAgentController`（路由 `/api/product`，appKey `product-agent`），含五类对象 CRUD + 表单模板引擎 + 流程定义引擎 + 通用流转端点。权限：`product-agent.use`（使用）/ `product-agent.manage`（模板与流程管理、删除产品）。

通用引擎要点：每个实例存 `FormData`（key=字段 Key）与 `CurrentState`（对应流程定义某状态）；创建时按绑定流程解析初始状态；流转时校验 transition 的 from→to 合法、目标状态存在、必要备注。

## 六、接口设计（P0 摘要）

- 产品：`POST/GET /products`、`GET/PUT/DELETE /products/{id}`
- 版本：`GET/POST /products/{id}/versions`、`PUT/DELETE /versions/{id}`
- 需求：`GET/POST /products/{id}/requirements`、`PUT/DELETE /requirements/{id}`
- 功能：`GET/POST /products/{id}/features`、`PUT/DELETE /features/{id}`、功能版本 `/feature-versions`
- 客户：`GET/POST /products/{id}/customers`、`PUT/DELETE /customers/{id}`
- 引擎：`GET/POST /form-templates`、`/workflow-definitions`、通用流转 `POST /transition`

## 七、实施波次

- P0（地基）：五类对象 CRUD + 通用表单引擎 + 通用状态机引擎 + 前端列表/详情骨架 + 导航注册。
- P1（关系与追溯）：对象关联的连边 UI + 缺陷追溯打通（引用 defect-agent）+ 知识库挂载（引用 DocumentStore）。
- P2（图谱与升级流）：知识图谱可视化 + 大版本升级申请可配置表单 + 看板视图 + 自定义表单/流程的可视化编辑器。

## 八、关联文档

- `doc/spec.srs.md` 附录D：需求可追溯矩阵 RTM（方法论来源）
- `doc/design.defect-agent.md`：缺陷管理（追溯引用对接）
- `.claude/rules/app-identity.md`：appKey 隔离
- `doc/debt.product-agent.md`：已知边界与后续债务

## 九、风险

- 通用引擎易过度设计：P0 只给够六类对象用的最小 schema。
- 与 defect-agent 边界：缺陷只追溯引用、不双写。
- 知识图谱性能：大产品节点多，P2 按版本/层级懒加载。
- MongoDB 索引：新集合索引需求登记到 `doc/guide.mongodb-indexes.md` 交 DBA（禁止应用自动建索引）。

## 十、已落地能力更新（2026-06-08）

### 10.1 里程碑健康度与实际完成时间

- `Milestone.ReachedAt`（实际完成时间）：有值即视为已完成，不再判逾期；`ReachedAt <= Deadline` 为按时，否则为逾期。
- `UpdateMilestone` 端点支持设置/清空 `ReachedAt`；前端里程碑详情新增「实际完成」时间填写入口，保存时实时提示按时/逾期。

### 10.2 任务进度与工作日志（pm_task_work_logs）

- `PmTask.ProgressPercent`：任务进度百分比，0-100；父任务按子任务进度自动汇总（roll-up）。
- `pm_task_work_logs` 集合：处理人按天记录工作内容与进度填报，填报进度时联动任务 `ProgressPercent`。
- 任务子任务强制两级约束（创建/挂载子任务时拒绝三级嵌套）。
- 任务独立详情页（`/pm-agent/p/:projectId/task/:taskId`）：双栏布局，左侧描述/工作日志/动态，右侧状态/进度/负责人/子任务/依赖；新建任务直接进入详情页空表单。

### 10.3 产品卡片动效

- 产品卡片入场淡入上浮错峰 + 悬停抬升青色辉光，含 `prefers-reduced-motion` 降级。
- 百宝箱与首页 AgentLauncherPage 产品管理智能体卡片统一知识图谱动态卡面（节点脉冲+连线数据流光+彗星沿链流动+光晕漂移）。

### 10.4 目标画布空状态修复

- 目标画布空状态判断改为按实际节点数（有根节点时不显示"还没有目标"）。
