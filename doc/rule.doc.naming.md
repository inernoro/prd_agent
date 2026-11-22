# 文档命名规则（doc/） · 规则

> **版本**：v3.4 | **日期**：2026-11-09 | **状态**：已落地

**一句话**：规定每篇文档叫什么名字——先写类型、再写应用名、子模块用点号接下去，让同一个应用的文档自动排在一起。
**谁该读**：要新建或重命名文档的人和 AI；想学会「看文件名就知道里面写什么」的读者。
**读完能做什么**：给一篇新文档起出合规的名字，并靠文件名直接定位到想找的那一篇。

---

## 文件命名格式

```
doc/{type}.{topic}.md
```

所有文档放在 `doc/` 扁平目录下，通过类型前缀分类。

### 类型前缀

| 前缀 | 含义 | 包含子类型 | 示例 |
|------|------|-----------|------|
| `spec.` | 产品规格 | 产品规格、Agent 产品文档、用户故事 | [spec.srs.md](./spec.srs.md), [spec.report-agent.v2.md](./spec.report-agent.v2.md) |
| `design.` | 技术设计 | 技术设计、技术分析 | [design.platform.server-authority.md](./design.platform.server-authority.md), [design.video-agent.remotion-gap.md](./design.video-agent.remotion-gap.md) |
| `plan.` | 实施计划 | 开发计划、迁移计划 | [plan.platform.llm-gateway.full-cutover.md](./plan.platform.llm-gateway.full-cutover.md) |
| `rule.` | 规范约定 | 长期规则、约束与门禁 | [rule.platform.app-identity.md](./rule.platform.app-identity.md), [rule.frontend.streaming-text.md](./rule.frontend.streaming-text.md) |
| `guide.` | 操作指南 | 指南、教程、运行手册 | [guide.platform.quickstart.md](./guide.platform.quickstart.md), [guide.platform.e2e-tests.md](./guide.platform.e2e-tests.md) |
| `report.` | 周报 | 周报 | [report.2026-W09.md](./report.2026-W09.md) |
| `debt.` | 历史台账前缀 | 工程债务在 CDS 按项目维护，旧版路径用于追溯 | [债务记录原则](./guide.doc.pri.debt.md) |
| `adr.` | 架构决策记录 | 架构、技术和工程流程的重要选择及其历史 | [文档位置与分层决策](./adr.doc.002.principle-location.md) |
| `pdr.` | 产品决策记录 | 产品价值、领域语义、商业边界与重要体验承诺 | [产品根基提议](./pdr.platform.001.product-foundation.md) |

### 类型原则与决策记录

`pri` 是 Principles 的缩写，表达文档类型的原则层次，不表示文件应位于仓库根目录。九类原则均作为指南放在 `doc/`，使用 `guide.doc.pri.<类型>.md`：guide 是已登记的类型，doc 是文档体系保留域，pri 与类型名是点分子主题。入口见 [README](../README.md#documentation)，它们与其他指南统一登记索引并接受导读、命名和链接检查。

文档创建前核对目录、命名、元数据与索引；用户要求新增类型或顶层内容，不自动授权存放例外。不得为迁就产物而增加根目录白名单、豁免索引或放宽检查。规则或守卫变更必须说明与原约束的差异及实际授权；当前依据见[位置与授权纠正](./adr.doc.002.principle-location.md)。

具体决策使用 `adr.<应用或领域>.<编号>.<主题>.md` 或 `pdr.<应用或领域>.<编号>.<主题>.md`。领域仍遵守下面的 appname 规则，例如跨项目文档体系用 doc、平台共性用 platform。编号在同类型与领域内稳定唯一，删除或被取代后不复用；跨项目引用带项目标识。

决策状态为已提议、已接受、已拒绝、已取代；不套用普通规格与计划的实施阶段。接受或拒绝后保留决策正文，更新状态和追溯元数据；重要变化另建记录。实施状态和适用范围单独填写。原则方法见 [ADR](./guide.doc.pri.adr.md) 与 [PDR](./guide.doc.pri.pdr.md)，初始记录见[决策清单](./guide.platform.decision-records.md)。

---

## topic 命名：appname 优先 + 点分层级（心智模型 SSOT）

`{type}.{topic}` 里的 **topic 必须「appname 优先、点分层级」**，让文档列表按应用天然聚成簇，读者扫一眼就建立心理预期；发布到知识库时别人也更容易理解归属。

格式：

```
{type}.{appname}[.{子模块}[.{子子模块}]].md
```

- **第一段 = appname**：应用 / 领域名，尽量对齐 [rule.platform.app-identity.md](./rule.platform.app-identity.md) 的 appKey（`cds` / `defect-agent` / `visual-agent` / `literary-agent` / `report-agent` / `video-agent` / `review-agent` / `pr-review` / `workflow-agent` 等）。
- **子模块用 `.` 续接**，**禁止**用 `-` 把 appname 和子模块黏在一起。每段内部仍是 kebab-case（段内单词用 `-`，段之间用 `.`）。
- 同一应用的所有文档第一段一致 → 排序后自动成簇。

| 正确（点分层级） | 含义 | 错误（连字符黏连） |
|------------------|------|--------------------|
| [spec.cds.md](./spec.cds.md) | cds 整体规格 | — |
| `spec.cds.settings.md` | cds 的 settings 子模块 | `spec.cds-settings.md` |
| `design.cds.agent.runtime.md` | cds → agent → runtime | `design.cds-agent-runtime-architecture.md` |
| [spec.defect-agent.automation-protocol.md](./spec.defect-agent.automation-protocol.md) | defect-agent 的自动化协议 | `spec.defect-agent-automation-protocol.md` |
| [design.defect-agent.automation-autonomy.md](./design.defect-agent.automation-autonomy.md) | 缺陷自动化自治体系 | `design.defect-automation-autonomy.md` |

> 注意：appKey 本身可含 `-`（如 `defect-agent`），它是**一个**段；`-` 不作分层用。分层只认 `.`。

### 例外（不强制 appname 优先）

| 类别 | 约定 | 示例 |
|------|------|------|
| 周报 | `report.YYYY-WNN.md`，时间即主题 | [report.2026-W13.md](./report.2026-W13.md) |
| 验收 / 事故报告 | **新增不进 `doc/`** —— 验收报告归验收知识库（`document_stores`，见 `create-visual-test-to-kb` 技能并出分享链）；事故复盘的架构教训并入相关 `design.*`，工程欠账登记到 CDS。`doc/` 的 `report.*` 目标收敛到周报（存量被引用者 grandfather，见 §报告/验收/图片不进 doc/） | 知识库分享链，不是 `doc/*.md` |
| 跨应用 / 平台级（不属单一 app） | 用保留域名段：`platform`（鉴权 / 网关 / 模型池 / 存储）、`frontend`（布局 / 模态 / 动效）、`skill`（技能体系）、`doc`（文档体系） | [design.platform.llm-gateway.md](./design.platform.llm-gateway.md)、`rule.frontend.modal.md`、[rule.skill.header.md](./rule.skill.header.md) |
| 顶层产品文档 | 保留概念名 | [spec.prd.md](./spec.prd.md)、[spec.srs.md](./spec.srs.md)、[spec.project-vision.md](./spec.project-vision.md) |

> 例外是「下限」：除上述四类，一律 appname 优先。拿不准时**优先归到某个 app**；确属跨切面才用保留域名段。新建文档前先想清楚它属于哪个 appname。

### canonical appname 分类（固化清单，2026-06-24）

appname 第一段**只能从下面四类里选，禁止自创**。新增应用 Agent 必须同步 [rule.platform.app-identity.md](./rule.platform.app-identity.md) 的 appKey。

- **一、应用 Agent**（对齐 `app-identity` appKey；新 Agent 文档加这一类）：`visual-agent` `literary-agent` `defect-agent` `report-agent` `video-agent` `review-agent` `pr-review` `workflow-agent` `product-agent` `speech-agent` `shortcuts-agent` `front-end-agent` `channel-agent` `ccas-agent` `page-agent` `prd-agent` `agent-universe` `emergence` `marketplace` `open-platform` `knowledge-base` `web-hosting` `daily-tips` `team-activity` `ai-toolbox` `arena` `md-to-ppt` `submission-gallery` `executive-dashboard` `admin` `desktop` `infra-sandbox-agent` `acceptance`
- **二、平台基础设施**：`cds`（云开发套件）、`platform`（鉴权 / 网关 / 模型池 / 存储等系统级）。
  网关不是独立 appname：LLM 网关文档一律走 `platform.llm-gateway.*`（如 [plan.platform.llm-gateway.full-cutover.md](./plan.platform.llm-gateway.full-cutover.md)），
  **禁止**写成 `llm-gateway.*` 或 `platform.llm-gateway-xxx`（后者用 `-` 把 appname 与子模块黏死，违反点分层级）。
- **三、跨切面保留域**：`frontend`（布局 / 模态 / 动效）、`skill`（技能体系）、`doc`（文档体系）
- **四、顶层产品**（无 appname 段，保留概念名）：`prd` `srs` `project-vision`

> `cds` 已达 100+ 篇（占 doc/ 约三成）。新增 cds 文档前先问能不能并入现有 canonical 文档，别再造「进度剧场」（见 [debt.cds.agent.md](https://github.com/inernoro/prd_agent/blob/853023509128fb785541408fd88591db860ce9bf/doc/debt.cds.agent.md) 的收敛计划）。

### 报告 / 验收 / 图片不进 doc/（2026-06-24 用户强制，最高约束）

用户多次发现验收报告、插图等临时产物掺进 doc/ 污染知识库。固化如下，违反即驳回：

1. **新增报告不进 doc/**：验收 / UAT / 事故 / 审计 / 进度 / 评测样本等一切「报告类临时文件」**一律不再新建到 doc/**。`doc/` 的 `report.*` **目标收敛到只剩周报 `report.YYYY-WNN.md`**。
2. 这类报告归**验收知识库**（`document_stores`，见 `create-visual-test-to-kb` 技能并出分享链），按主题分流：**MAP（prd-agent 平台自身）主题 → MAP 知识库；其余（CDS 及其他）→ CDS 知识库**。
3. 事故复盘的长期架构结论并入相关 `design.*`，尚需处理的工程问题登记到 CDS。
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
- **类型后缀**：按下面的类型登记，用 ` · ` 分隔放在末尾，与文件名前缀对应：

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
| `adr.` | ` · 架构决策` |
| `pdr.` | ` · 产品决策` |

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

ADR/PDR 使用上文独立的决策状态，不以「已落地」代替接受，也不以「已接受」证明已实施。

### 反模式

```markdown
<!-- 错误：粗体键值对（旧格式） -->
**文档版本**：v1.0
**创建日期**：2025-01-25
**最后更新**：2025-01-25

<!-- 错误：缺少"状态"字段 -->
> **版本**：v1.0 | **创建日期**：2026-03-04
```

---

## 规则

1. **topic 使用 `kebab-case`**
2. **所有文档放 `doc/` 根目录**，不使用子文件夹
3. **新增 Agent** 至少需要 `spec.{name}.md`（需求）+ `design.{name}.md`（设计）
4. **每个文件必须包含标准头部**（版本 + 日期 + 状态）

---

## 工程债务与历史台账

已确认的工程债务登记在 CDS 工程规划，按项目和模块维护。留下问题影响、当时的取舍、偿还触发条件与复核证据。交接和报告引用 CDS 中的正式债务编号，原台账用固定 Git 版本回读。 [债务记录原则](./guide.doc.pri.debt.md)

计划、决策和现行约束各自在对应文档维护，通过正式债务编号关联。
