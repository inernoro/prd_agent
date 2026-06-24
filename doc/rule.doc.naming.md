# 文档命名规则（doc/）

> **版本**：v3.1 | **日期**：2026-04-26 | **状态**：已落地

## 文件命名格式

```
doc/{type}.{topic}.md
```

所有文档放在 `doc/` 扁平目录下，通过类型前缀分类。

### 类型前缀

| 前缀 | 含义 | 包含子类型 | 示例 |
|------|------|-----------|------|
| `spec.` | 产品规格 | 产品规格、Agent 产品文档、用户故事 | `spec.srs.md`, `spec.report-agent.v2.md` |
| `design.` | 技术设计 | 技术设计、技术分析 | `design.platform.server-authority.md`, `design.video-agent.remotion-gap.md` |
| `plan.` | 实施计划 | 开发计划、迁移计划 | `plan.report-agent.impl.md` |
| `rule.` | 规范约定 | 规范约定、审计报告 | `rule.platform.app-identity.md`, `rule.frontend.audit-prd-desktop-codebase.md` |
| `guide.` | 操作指南 | 指南、教程、备忘录 | `guide.platform.quickstart.md`, `guide.visual-agent.multi-image-compose-test.md` |
| `report.` | 周报 | 周报 | `report.2026-W09.md` |
| `debt.` | 技术债务台账 | 模块级未还工程债（已知边界、后续可补、TODO、留尾风险） | `debt.video-agent.md`, `debt.cds.md` |

---

## topic 命名：appname 优先 + 点分层级（心智模型 SSOT）

`{type}.{topic}` 里的 **topic 必须「appname 优先、点分层级」**，让文档列表按应用天然聚成簇，读者扫一眼就建立心理预期；发布到知识库时别人也更容易理解归属。

格式：

```
{type}.{appname}[.{子模块}[.{子子模块}]].md
```

- **第一段 = appname**：应用 / 领域名，尽量对齐 `rule.platform.app-identity.md` 的 appKey（`cds` / `defect-agent` / `visual-agent` / `literary-agent` / `report-agent` / `video-agent` / `review-agent` / `pr-review` / `workflow-agent` 等）。
- **子模块用 `.` 续接**，**禁止**用 `-` 把 appname 和子模块黏在一起。每段内部仍是 kebab-case（段内单词用 `-`，段之间用 `.`）。
- 同一应用的所有文档第一段一致 → 排序后自动成簇。

| 正确（点分层级） | 含义 | 错误（连字符黏连） |
|------------------|------|--------------------|
| `spec.cds.md` | cds 整体规格 | — |
| `spec.cds.settings.md` | cds 的 settings 子模块 | `spec.cds-settings.md` |
| `design.cds.agent.runtime.md` | cds → agent → runtime | `design.cds-agent-runtime-architecture.md` |
| `spec.defect-agent.automation-protocol.md` | defect-agent 的自动化协议 | `spec.defect-agent-automation-protocol.md` |
| `design.defect-agent.automation-autonomy.md` | 缺陷自动化自治体系 | `design.defect-automation-autonomy.md` |

> 注意：appKey 本身可含 `-`（如 `defect-agent`），它是**一个**段；`-` 不作分层用。分层只认 `.`。

### 例外（不强制 appname 优先）

| 类别 | 约定 | 示例 |
|------|------|------|
| 周报 | `report.YYYY-WNN.md`，时间即主题 | `report.2026-W13.md` |
| 验收 / 事故报告 | **不进 `doc/`** —— 验收报告归验收知识库（`document_stores`，见 `create-visual-test-to-kb` 技能并出分享链）；事故 postmortem 的架构教训并入相关 `design.*` / `debt.*`。`doc/` 的 `report.*` 只保留周报 | 知识库分享链，不是 `doc/*.md` |
| 跨应用 / 平台级（不属单一 app） | 用保留域名段：`platform`（鉴权 / 网关 / 模型池 / 存储）、`frontend`（布局 / 模态 / 动效）、`skill`（技能体系）、`doc`（文档体系） | `design.platform.llm-gateway.md`、`rule.frontend.modal.md`、`rule.skill.header.md` |
| 顶层产品文档 | 保留概念名 | `spec.prd.md`、`spec.srs.md`、`spec.project-vision.md` |

> 例外是「下限」：除上述四类，一律 appname 优先。拿不准时**优先归到某个 app**；确属跨切面才用保留域名段。新建文档前先想清楚它属于哪个 appname。

### canonical appname 分类（固化清单，2026-06-24）

appname 第一段**只能从下面四类里选，禁止自创**。新增应用 Agent 必须同步 `rule.platform.app-identity.md` 的 appKey。

- **一、应用 Agent**（对齐 `app-identity` appKey；新 Agent 文档加这一类）：`visual-agent` `literary-agent` `defect-agent` `report-agent` `video-agent` `review-agent` `pr-review` `workflow-agent` `product-agent` `speech-agent` `shortcuts-agent` `front-end-agent` `channel-agent` `ccas-agent` `page-agent` `prd-agent` `agent-universe` `emergence` `marketplace` `open-platform` `knowledge-base` `web-hosting` `daily-tips` `team-activity` `ai-toolbox` `arena` `md-to-ppt` `submission-gallery` `executive-dashboard` `admin` `desktop` `infra-sandbox-agent` `acceptance`
- **二、平台基础设施**：`cds`（云开发套件）、`platform`（鉴权 / 网关 / 模型池 / 存储等系统级）
- **三、跨切面保留域**：`frontend`（布局 / 模态 / 动效）、`skill`（技能体系）、`doc`（文档体系）
- **四、顶层产品**（无 appname 段，保留概念名）：`prd` `srs` `project-vision`

> `cds` 已达 100+ 篇（占 doc/ 约三成）。新增 cds 文档前先问能不能并入现有 canonical 文档，别再造「进度剧场」（见 `debt.cds.agent.md` 的收敛计划）。

### 报告 / 验收 / 图片不进 doc/（2026-06-24 用户强制，最高约束）

用户多次发现验收报告、插图等临时产物掺进 doc/ 污染知识库。固化如下，违反即驳回：

1. **新增报告不进 doc/**：验收 / UAT / 事故 / 审计 / 进度 / 评测样本等一切「报告类临时文件」**一律不再新建到 doc/**。`doc/` 的 `report.*` **目标收敛到只剩周报 `report.YYYY-WNN.md`**。
2. 这类报告归**验收知识库**（`document_stores`，见 `create-visual-test-to-kb` 技能并出分享链），按主题分流：**MAP（prd-agent 平台自身）主题 → MAP 知识库；其余（CDS 及其他）→ CDS 知识库**。
3. 事故 postmortem 若有长期架构价值，把结论并入相关 `design.*` / `debt.*`，不单独留 `report.*` 文件。
4. **图片 / 插图不进仓库**：文档配图走知识库上传 / 外链，不 commit 进 `doc/` 或 `assets/`。例外：应用 UI 资源（如 `prd-admin/src/assets/**`、favicon、model-avatars）是**代码资源**，不受此限。
5. **存量 grandfather（非绝对句的关键）**：已存在且**被设计文档 / 脚本 / 后端代码引用**的非周报 `report.*`（如 CDS Agent 阶段验收报告被 `design.cds.agent.commercial-architecture-and-roadmap` 引用、`report.cds.forwarder-success` 被多篇 guide/design 引用）**暂时保留**，待**专项迁移任务**把它们搬去知识库 + 同步更新所有引用后再移除。**在此之前禁止简单删除**——会产生悬挂引用。本规则约束「新增」与「目标」，不要求即刻清空存量。

> 历史背景：2026-06-24 按本规则从 doc/ 移走约 16 篇**零引用**的孤立报告 + 2 张报告插图 PNG。同期发现验收报告被脚本 / 后端 / 设计文档深度引用，**简单删除连环踩坑三轮**（scripts → 后端 → doc 交叉链接），故把被引用的 18 篇恢复并改为 grandfather。教训：存量报告迁移是独立专项，不能在重命名 PR 里顺手删。git 历史可追溯。

---

## 文件头部格式

每个文档的开头必须包含标准头部信息，统一使用 blockquote 键值对格式：

```markdown
# <应用/主题> [副标题] · <类型后缀>

> **版本**：v1.0 | **日期**：2026-03-04 | **状态**：已落地

正文内容...
```

### H1 标题规约

**格式**：`# <应用/主题> [副标题] · <类型后缀>`

- **应用/主题**：优先把应用名或核心主题放在最前（`CDS xxx`、`缺陷管理 xxx`、`文学创作 xxx`）。知识库按"正文第一行"显示标题时，应用名在最前最醒目。
- **副标题**：可选，直接空格或冒号承接。
- **类型后缀**：固定 7 种，用 ` · ` 分隔放在末尾，与文件名前缀一一对应：

| 文件名前缀 | H1 类型后缀 |
|------------|------------|
| `spec.` | ` · 规格` |
| `design.` | ` · 设计` |
| `plan.` | ` · 计划` |
| `rule.` | ` · 规则` |
| `guide.` | ` · 指南` |
| `report.YYYY-WNN` | ` · 周报` |
| `report.*`（其他） | ` · 报告` |
| `debt.` | ` · 债务台账` |

**禁止使用的旧式后缀**（已统一清理）：`设计方案` / `设计文档` / `设计稿` / `功能设计` / `架构设计` / `技术设计` / `架构文档` / `设计规范` / `方案` / `操作手册` / `操作指南` / `用户手册` / `使用手册` / `手册` / `教程` / `规范` / `约定` / `约束` / `规格说明` / `规格说明书` / `产品规格` / `实施计划` / `开发计划` / `迁移计划` / `月报` / `日报`

**例外**：如果标题本身已经包含了类型关键词（如 "服务器权威性**设计**"、"CDS 极简上手**设计**：xxx"、"PRD 理解与交互智能体软件需求**规格**说明书"），追加 ` · 类型` 会造成重复，此时**可以不追加**，保留原标题。

### 规范示例

```markdown
# CDS 数据迁移 · 设计
# PRD 快速启动 · 指南
# 应用身份隔离原则 · 规则
# PRD Agent 产品需求 · 规格
# 2026-W13 (2026-03-23 ~ 2026-03-29) · 周报
```

### 字段说明

| 字段 | 是否必须 | 值 | 说明 |
|------|---------|-----|------|
| **版本** | 必须 | `v1.0` / `v2.0` | 大改动升主版本，小修改升次版本 |
| **日期** | 必须 | `YYYY-MM-DD` | 最后更新日期 |
| **状态** | 必须 | 见下表 | 文档当前生命阶段 |
| **appKey** | 仅 Agent 规格文档 | `defect-agent` | 关联的应用标识 |

### 状态枚举

| 状态值 | 含义 |
|--------|------|
| `草案` | 初稿，未评审 |
| `规划中` | 已评审，待开发 |
| `开发中` | 正在实现 |
| `已落地` | 代码已实现并上线 |
| `已废弃` | 不再维护，仅保留归档 |

### 反模式

```markdown
<!-- ❌ 粗体键值对（旧格式） -->
**文档版本**：v1.0
**创建日期**：2025-01-25
**最后更新**：2025-01-25

<!-- ❌ 缺少"状态"字段 -->
> **版本**：v1.0 | **创建日期**：2026-03-04
```

---

## 规则

1. **topic 使用 `kebab-case`**
2. **所有文档放 `doc/` 根目录**，不使用子文件夹
3. **新增 Agent** 至少需要 `spec.{name}.md`（需求）+ `design.{name}.md`（设计）
4. **每个文件必须包含标准头部**（版本 + 日期 + 状态）

---

## debt.* 专项约定

技术债务台账按**模块**归档，一个模块一个文件，例如 `debt.video-agent.md`、`debt.cds.md`、`debt.llm-gateway.md`。

### 适用场景

- 交付完成时声明的"已知边界 / 后续可补 / 留尾风险"
- 时间紧赶上线但留了 TODO 的位置
- 新功能的成本/性能/兼容性等需要观察才能判断是否还的不确定点
- 别人写的代码你看不顺眼但当下不该改的（先记下，碰到再改）

**不属于 debt.***：
- 已经有明确实施计划的——用 `plan.*`
- 设计选型或架构决策——用 `design.*`
- 团队约定的禁止/必须事项——用 `rule.*`

### 文件结构

```markdown
# {模块名} · 债务台账

> **版本**：v1.0 | **日期**：2026-04-26 | **状态**：维护中

## 总览

当前 open: N / paid: M / 总计: N+M

## 债务列表

| ID | 严重度 | 创建日期 | 描述 | 触发条件 | 状态 | 备注 |
|----|--------|---------|------|---------|------|------|
| 2026-04-26-cost-preview | low | 2026-04-26 | 切到直出 chip 时未显示预估总成本 | 用户开始关心钱时 | open | hover tooltip 即可 |
| ...(下一条) | | | | | | |

## 已还的债务（归档）

> 修复后从上面表格挪到这里，保留以便复盘

| ID | 修复 PR | 修复日期 | 备注 |
|----|---------|---------|------|
```

### 字段约定

- **ID** = `YYYY-MM-DD-{kebab-case 简短描述}`（同日多条用 `-1` `-2` 区分）
- **严重度** = `critical` / `high` / `medium` / `low`
- **状态** = `open` / `in-progress` / `paid`
- **触发条件** = "什么情况下值得还这笔债"——避免把不该现在还的债提前还了

### 与其他系统的关系

- `/handoff` 技能交付时如果有"已知边界"段落，**应主动写入对应 `debt.*` 文件**而不是只留在 commit message
- `/dev-report` 三段式报告里的"风险/后续事项"同样应固化到 `debt.*`
- `/weekly` 周报应统计本周 open 数与 paid 数变化（"还了 3 条债，新欠了 2 条"）
- 还债时：从 open 表挪到"已还的债务"区，commit message 引用债务 ID
