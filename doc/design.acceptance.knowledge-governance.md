# MAP 自动化验收知识库治理 · 设计

> **版本**：v1.0 | **日期**：2026-07-07 | **状态**：已落地

关联规范: `doc/rule.acceptance.map-enterprise.md`。

## 1. 目标

验收知识资产分为两类:

1. 长期规范: 可复用、可评审、可版本化，放在 `doc/`。
2. 执行产物: 每次验收的报告、截图、manifest、链接、verdict，放在 CDS `/reports`。

这能避免两个问题:

- 把每日执行报告塞进仓库，污染长期知识。
- 把规范只写在 CDS 报告正文里，无法版本化和审查。

## 2. 文档信息架构

| 层级 | 作用 | 放哪里 | 内容边界 |
|---|---|---|---|
| 基础规范 | 统一术语和判断口径 | `doc/rule.acceptance.map-enterprise.md` | MAP 验收、L0/L1/L2、P0-P3、证据链、Verdict、CDS/CDS Agent 边界 |
| 执行 SOP | 教会如何跑一轮 | `doc/guide.acceptance.daily-sop.md` | 范围冻结、CDS ready、取证、归档、verify-open、Slack |
| 报告证据规范 | 规范报告长什么样 | `doc/guide.acceptance.report-evidence.md` | 信息架构、截图、链接、失败红标、右侧证据栏 |
| 技能实现 | 可执行规则和脚本 | `.claude/skills/**` | 技能触发、脚本、模板、准入校验 |
| 执行报告 | 每次验收结果 | CDS `/reports` | HTML/Markdown 报告、截图资产、元数据、分享链 |
| 治理台账 | 例外和债务 | `doc/debt.*` | 暂未覆盖能力、计划迁移、规范冲突 |

## 3. 引用规范

报告里不要复制整段规范。应写“适用解释”，先用自己的语言说明为什么引用该规范，再给链接。

合格结构:

```markdown
## 标记法则与验收标准

本次验收采用 MAP 企业级自动化验收规范 v1.0。本次改动影响用户可见页面和报告链接交互，因此按“页面优先证据”和“链接可用性”处理：先验证用户普通左键点击后的页面行为，再用 CSP header 和路由测试作为内部佐证。单独看到 href 或 API 200 不能支撑通过。

引用:
- MAP 企业级自动化验收规范 v1.0，页面优先证据
- MAP 验收报告与证据交互规范 v1.0，链接可用性
```

引用必须包含:

| 字段 | 要求 |
|---|---|
| 标准名 | 例如 `MAP 企业级自动化验收规范` |
| 版本 | 例如 `v1.0` |
| 章节或规则 | 引到最小稳定章节 |
| 本次适用解释 | 用自己的话说明为什么适用、怎么影响测试动作和 Verdict |
| 链接 | HTTPS 或仓库内稳定路径 |

反例:

```markdown
参考 MAP 验收标准。
```

为什么不合格: 读者不知道引用了哪条规则，也不知道它如何影响本轮验收。

## 4. CDS 文件夹组织

CDS `/reports` 建议按项目和场景组织:

```text
prd-agent
├── 2026-07 每日验收
├── 2026-07 PR 验收
├── 2026-07 缺陷复测
├── 发布前阻断验收
└── 规范演练与样本
```

报告标题固定:

```text
{项目} · {模块} · {功能} · {操作方式} · 验收报告
```

状态不写进标题，放元数据。

| 元数据 | 用途 |
|---|---|
| `verdict` | pass、conditional、fail |
| `tier` | L0、L1、L2 或每日深度验收 |
| `branch` | 被测分支 |
| `commitSha` | 被测提交 |
| `prNumber` | 关联 PR |
| `defectCounts` | P0/P1/P2/P3 数量 |
| `folderId` | 归档目录 |
| `shareToken` | 对外只读分享 |

## 5. 互链规则

| 来源 | 链到哪里 | 禁止 |
|---|---|---|
| PR 评论 | CDS 报告深链 `/reports?project=&folder=&report=` | 复制完整报告正文 |
| Slack | CDS HTTPS 报告链接和短摘要 | `/tmp`、`file://` |
| 报告正文 | 预览深链、commit、PR、规范章节 | 不可点击裸文本 |
| MAP 知识库 | 通过 peer-sync 拉 CDS 报告 | 手工复制截图和正文 |
| 周报/日报 | 报告链接和结论 | 搬运截图墙 |
| 缺陷复测 | 原始失败报告和复测报告 | 只写“已修复” |

## 6. 版本和 Owner

| 资产 | Owner | 复核人 |
|---|---|---|
| MAP 验收基础标准 | QA/验收规范 Owner | 产品 Owner、技术 Owner |
| 自动化 harness/SOP | 平台/工具 Owner | QA Owner |
| CDS 报告中心契约 | CDS Owner | MAP Owner |
| 具体报告 | 执行 Agent | 请求验收的人或模块 Owner |

版本升级:

| 变更类型 | 升级方式 |
|---|---|
| 新增硬门禁、改变 Verdict 判定 | 主版本或明确 `v2.x` 升级，并写迁移说明 |
| 新增示例、澄清措辞 | 次版本 |
| 修 typo、不改变行为 | patch 或只更新日期 |
| 临时例外 | 不改标准，写入报告例外说明和债务台账 |

## 7. 复核节奏

| 节奏 | 内容 |
|---|---|
| 每次报告归档前 | 结构门禁、截图门禁、证据链门禁、线上打开验证 |
| 每周 | 抽查 3 到 5 篇报告，看弱证据、伪深度、断链 |
| 每月 | 汇总不合格原因，反哺规范或 SOP |
| 每次事故后 | 只把可复用教训升为规则，不把一次性细节塞进标准 |

## 8. 避免伪企业级

判断标准: 规范必须改变执行结果，否则就是摆设。

必须坚持:

1. 不用大词替代证据。企业级、全链路、深度验收必须对应范围、行为断言、证据矩阵、缺口账本。
2. 不用截图数量冒充质量。每张图必须回答“证明了什么”。
3. 不用 API 200 冒充用户通过。用户可见变更先看页面反馈。
4. 不用相邻页面冒充行为证明。知识库列表可见不代表同步成功。
5. 不用 CDS Agent 页面冒充 CDS 平台能力通过。
6. 不把规范复制进 prompt。自动化 prompt 只做调度壳。
7. 不让报告进 `doc/` 污染长期知识。报告是证据资产，放 CDS。

## 9. 外部参考

- ISTQB Glossary: Impact Analysis  
  https://glossary.istqb.org/en_US/term/impact-analysis
- ISTQB Glossary: Traceability  
  https://glossary.istqb.org/en_US/term/traceability
- ISO/IEC/IEEE 29119-1:2022 Software testing, general concepts  
  https://www.iso.org/standard/81291.html
- ISO/IEC/IEEE 29119 series overview  
  https://committee.iso.org/sites/jtc1sc7/home/projects/flagship-standards/isoiecieee-29119-series.html
- Google Testing Blog: Just Say No to More End-to-End Tests  
  https://testing.googleblog.com/2015/04/just-say-no-to-more-end-to-end-tests.html
- Martin Fowler: The Practical Test Pyramid  
  https://martinfowler.com/articles/practical-test-pyramid.html
- NIST Automated Combinatorial Testing for Software  
  https://csrc.nist.gov/projects/automated-combinatorial-testing-for-software
