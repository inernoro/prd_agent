# 百科全书导读 —— 人类怎么读这套文档 · 指南

> **版本**：v1.0 | **日期**：2026-07-31 | **状态**：已落地

**一句话**：告诉你这套两百多万字的文档不用通读，按你的角色只读那几篇就够，其余的等撞上了再查。
**谁该读**：第一次面对这套文档不知道从哪下手的人；想给新同事指路的人；想知道某件事该去哪查的人。
**读完能做什么**：按自己的角色挑出该读的三到六篇，并知道任何一类问题该去哪一类文档找答案。

---

## 一、先说结论：这套文档不是拿来读完的

| 事实 | 数字 |
|------|------|
| `doc/` 长期文档 | 352 篇、约 232 万字 |
| 全部读完 | 约 97 小时 |
| 真正需要**所有人**读的 | **6 篇**（见下方「地基六篇」） |

其余 340 多篇是**参考书，不是教科书**：撞上具体问题时按图索骥，不是入职第一周从 A 读到 Z。
判断标准很简单——**你现在有没有一个具体问题？** 有就查对应类型；没有就只读地基六篇，别的先放着。

---

## 二、三层结构：先搞清楚东西都放在哪

这套知识分三层，**放的地方不同、更新频率不同、读法也不同**：

| 层 | 是什么 | 放在哪 | 多久变一次 | 怎么读 |
|---|---|---|---|---|
| **头版**（每天变的） | 日报、周报、验收报告 | 知识库（日报 / 周报知识库）与 CDS 验收中心，**不进 `doc/`** | 每天 / 每周 / 每次验收 | 像读报纸，只读最新一期，已是说人话版 |
| **地基**（很少变的） | 产品规格、技术设计、规则、指南、债务、计划 | `doc/` 七类前缀 | 月级 | 按需检索，本文教你怎么检索 |
| **围栏**（AI 每次都读） | 开发纪律与架构约束 | `CLAUDE.md` + `.claude/rules/*.md` | 撞坑就加一条 | 人不必通读；想知道「为什么不让这么写」时去查 |

**为什么日报周报不进 `doc/`**：它们是「某天发生了什么」的快照，会过期；`doc/` 存的是「这个东西是什么、
为什么这么设计」的长期事实。两者混在一起，长期事实会被流水账淹没。

---

## 三、地基六篇（不管你是谁，先读这六篇）

按顺序读，总共约 40 分钟：

1. [spec.project-vision.md](./spec.project-vision.md) —— 我们到底在解决什么问题，为什么要有这个系统。
2. [spec.prd.md](./spec.prd.md) —— 产品做成什么样，有哪些能力。
3. [guide.platform.quickstart.md](./guide.platform.quickstart.md) —— 怎么把系统跑起来。
4. [guide.platform.principles.md](./guide.platform.principles.md) —— 系统里所有「有名号的原则」一页速查（2 秒原则、好用四原则、无根之木禁令……），读完就知道这里做事的价值观。
5. [rule.doc.naming.md](./rule.doc.naming.md) —— 文件名怎么读，这决定了你以后能不能自己找到东西。
6. **本文** —— 怎么找剩下的 346 篇。

---

## 四、按角色：你是谁，就读这几篇

### 老板 / 投资人（想知道在做什么、做得怎么样）
- 常读：**周报**（知识库「周报知识库」，业务价值 + 质量闸 + 下周优先级，技术细节在附录）
- 偶尔：[spec.project-vision.md](./spec.project-vision.md)（愿景）、[spec.prd.md](./spec.prd.md)（产品全貌）
- **不用读**：`design.` / `debt.` / `plan.` 全部。那是施工图，不是竣工报告。

### 产品经理（要提需求、要验收）
- 起手：[spec.prd.md](./spec.prd.md) + 目标模块的 `spec.{应用名}.md`（如 [spec.defect-agent.md](./spec.defect-agent.md)）
- 验收前：[rule.acceptance.map-enterprise.md](./rule.acceptance.map-enterprise.md)（验收标准）+ 最近的验收报告（CDS 验收中心）
- 提需求前：跑 `/validate` 技能，比读任何文档都快

### 新来的工程师（第一周）
- 第 1 天：地基六篇 + [guide.platform.development-guide.md](./guide.platform.development-guide.md)
- 第 2 天：`CLAUDE.md`（开发纪律总纲）+ 你要动的那个模块的 `design.{模块}.md`
- 第 3 天起：**别再读了，去改一个小东西**。撞上什么再查什么——这套文档是为「撞上了」设计的。

### 值班 / 排障（线上出事了）
- 先查 `debt.{模块}.md` —— **看看是不是已知边界**，这一步能省掉大部分无用排查。
- 再查 `guide.{模块}.*` 里的 runbook（如 [guide.cds.agent.runbook.md](./guide.cds.agent.runbook.md)）。
- 发布相关：[rule.platform.production-release-safety.md](./rule.platform.production-release-safety.md)。
- 找数据在哪：[rule.platform.data-dictionary.md](./rule.platform.data-dictionary.md)。

### 接手一个模块的人
按这个顺序读同一个应用名的四篇，从「是什么」到「欠什么」：
```
spec.{应用}.md   →   design.{应用}.md   →   plan.{应用}.*.md   →   debt.{应用}.md
 做什么              怎么做的               还要做什么            欠了什么
```
四篇读完就是这个模块的完整交接。**`debt.` 那篇千万别跳过**——它写的是前人故意没做的事和原因。

### AI Agent
`CLAUDE.md` + `.claude/rules/*.md` 是强制纪律（按 glob 自动加载），`doc/` 是查证来源。
写文档前先读 [rule.doc.naming.md](./rule.doc.naming.md)（放哪、叫什么）和
[rule.doc.readability.md](./rule.doc.readability.md)（开头怎么写）。

---

## 五、按场景：我有个具体问题，去哪查

| 我的问题 | 去哪查 |
|---|---|
| 这个功能是干什么的 | `spec.{应用}.md` |
| 为什么当初这么设计 | `design.{应用}.*.md` 的管理摘要 |
| 这块什么时候能做完 / 现在到哪一步了 | `plan.{应用}.*.md` 的状态看板（顶部第一屏） |
| 我这么写会不会挨骂 | `.claude/rules/` 对应规则 + `doc/rule.*` |
| 怎么操作 / 怎么部署 / 怎么跑起来 | `guide.*` |
| 这个坑是不是已知的 | `debt.{模块}.md` |
| 上周做了什么 / 昨天做了什么 | 周报知识库 / 日报知识库（不在 `doc/`） |
| 这次改动验收过了吗 | CDS 验收中心的验收报告（不在 `doc/`） |
| 有哪些文档 | [guide.list.directory.md](./guide.list.directory.md)（人看）/ `index.yml`（工具看） |
| 有哪些技能可以用 | `CLAUDE.md` 技能表 + [guide.skill.catalog.md](./guide.skill.catalog.md) |

---

## 六、怎么自己找到一篇文档

**文件名是可以读的**，格式是 `类型.应用名.子模块.md`：

```
design . cds . agent . runtime . md
  │      │     │       │
  │      │     │       └── 更细的子模块
  │      │     └── 子模块
  │      └── 应用名（cds / defect-agent / visual-agent / platform / frontend …）
  └── 类型（spec 做什么 / design 怎么做 / plan 何时做 / rule 不能怎么做 /
            guide 怎么操作 / report 做了什么 / debt 欠了什么）
```

所以找东西的顺序是：**先想清楚我要的是哪一类（七选一），再想是哪个应用**，然后：

```bash
ls doc/design.cds.*        # 某个应用的全部设计文档
ls doc/debt.*              # 全系统欠了哪些债
grep -l "关键词" doc/*.md  # 不知道在哪篇时全文搜
```

---

## 七、不在 `doc/` 里的东西（别在这儿找）

| 找不到的东西 | 实际在哪 |
|---|---|
| 日报、周报 | 知识库的「日报知识库」「周报知识库」（周报同时留一份底稿在 `doc/report.YYYY-WNN.md`） |
| 验收报告、截图证据 | CDS 验收中心（每份报告自带可分享链接） |
| 更新记录 | `changelogs/` 碎片文件，发版时合并进 `CHANGELOG.md` |
| AI 开发纪律 | `CLAUDE.md` + `.claude/rules/*.md` |
| 技能怎么用 | `.claude/skills/*/SKILL.md` |

---

## 八、读不懂怎么办

**读不懂是文档的问题，不是你的问题。** 按这条规则处理：

1. 那篇文档如果没有开头的「导读三行」（一句话 / 谁该读 / 读完能做什么），
   直接按 [rule.doc.readability.md](./rule.doc.readability.md) 给它补上——谁读到谁补，这是本仓库的常规操作。
2. 补完跑一次 `python3 scripts/doc-readability-check.py --update-baseline`，把欠账基线压低一格。
3. 引用点不开（写成了灰底代码而不是蓝色链接）时，跑一次
   `python3 scripts/doc-readability-check.py --fix-links` 就会全库改成可点链接。
4. 如果是内容本身讲不清楚，在对应 `debt.{模块}.md` 记一条，别让下一个人再踩一遍。

## 九、相关

- [rule.doc.readability.md](./rule.doc.readability.md) —— 作者视角：单篇文档开头怎么写。
- [rule.doc.naming.md](./rule.doc.naming.md) —— 文件放哪、叫什么名。
- [rule.doc.templates.md](./rule.doc.templates.md) —— 七类文档的正文模板。
- [guide.list.directory.md](./guide.list.directory.md) —— 全量文档清单（按类型排序）。
