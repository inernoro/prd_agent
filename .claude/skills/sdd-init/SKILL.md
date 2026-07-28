---
name: sdd-init
description: 把刚装好的角色技能套装落地到当前项目——探测现状、生成 CLAUDE.md 规则骨架、doc/ 七类文档骨架和角色路线图，并输出「已装什么 / 还缺什么 / 下一步做什么」的自检报告。让下载完技能的人不再面对一个空仓库发呆。触发词："/sdd-init"、"初始化项目"、"技能落地"、"装完技能怎么开始"、"搭工作方法"。
---

# SDD 初始化 — 把技能套装变成一套能用的工作方法

> **版本**：v1.0.0 | **状态**：已落地 | **触发**：`/sdd-init`、"初始化项目"、"装完技能怎么开始"

## 这个技能解决什么

用户刚把一个角色套装装进项目的技能目录（`.claude/skills` / `.cursor/skills` / `.agents/skills` 三者之一），现在面对的是：一堆不知道何时该用的斜杠命令，和一个没有任何约定的项目目录。

技能是零件，**规则和文档骨架才是把零件串起来的机床**。本技能负责装机床：

```
下载套装  →  /sdd-init  →  CLAUDE.md（规则）+ doc/（文档骨架）+ 路线图  →  可以开始干活
             ~~~~~~~~~
             本技能
```

## 核心原则：探测优先，能推断的不问

每问用户一个问题都是一次流失。按下面顺序做，**先探测再提问**，最多问 2 个问题。

---

## 第一步：探测现状（不问用户，自己看）

按顺序执行，把结果记下来，后面每一步都依赖它：

```bash
# 1. 项目根在哪、是不是 git 仓库
pwd; git rev-parse --show-toplevel 2>/dev/null || echo "非 git 仓库"

# 2. 已有骨架？（决定是「新建」还是「增量补齐」）
ls -d CLAUDE.md AGENTS.md doc docs .claude/rules changelogs 2>/dev/null

# 3. 装了哪些技能（判断用户拿的是哪个角色套装）
#    三个宿主目录都要看：Claude Code 用 .claude、Cursor 用 .cursor、
#    通用 Agent Skills / Codex 用 .agents。引导脚本装到哪个是按项目现状探测的，
#    只看 .claude 会把 Codex 项目误判成「一个技能都没装」，接着写错规则文件名、
#    生成空技能索引。
for d in .claude/skills .cursor/skills .agents/skills; do
  [ -d "$d" ] && { echo "== $d"; ls "$d"; }
done
cat .cds/bootstrap.json 2>/dev/null   # 引导脚本留的种子：预设、技能目录、装了什么

# 4. 项目类型（决定 CLAUDE.md 里写什么构建命令）
ls package.json pyproject.toml requirements.txt go.mod Cargo.toml pom.xml *.sln *.csproj 2>/dev/null
```

探测结论按下表推断，**推断得出的一律不问**：

| 探测到 | 推断 |
|---|---|
| 装了 `product-document-generator` / `skill-validation` / `plan-first` | 角色 = 产品经理 |
| 装了 `code-hygiene` / `human-verify` / `conflict-resolution` | 角色 = 开发 |
| 装了 `acceptance-checklist` / `acceptance-test-design` | 角色 = 测试 / 验收 |
| 有 `package.json` | Node 项目，构建命令从 `scripts` 字段读 |
| 有 `pyproject.toml` / `requirements.txt` | Python 项目 |
| 已有 `doc/` 或 `docs/` | 增量补齐模式，**不覆盖已有文件** |
| 已有 `CLAUDE.md` | 追加模式，只补缺失章节，**绝不整篇覆写** |

## 第二步：只问真正问不出来的（最多 2 个）

只有下面两件事无法从探测推断，才需要问。**其余一律用默认值，并在最后的报告里说明用了什么默认值。**

1. **这个项目是做什么的**（一句话）—— 用来填 CLAUDE.md 的开头，让后续对话有上下文。
2. **文档放哪**（默认 `doc/`）—— 只有当项目已存在 `docs/` 时才问「用你已有的 `docs/` 还是新建 `doc/`」，否则直接用 `doc/`。

角色如果第一步没推断出来（比如用户手工装的技能），才补问一次角色。

不要问的（都有明确默认）：要不要 git、版本号从几开始、用不用 changelog、文档要不要编号。

## 第三步：生成骨架

按下面清单逐个生成。**已存在的文件一律跳过并在报告里标注「已存在，跳过」，绝不覆盖用户已有内容。**

**规则文件叫什么，取决于宿主**（第一步探测到的技能目录决定，不要一律写 `CLAUDE.md`）：

| 探测到的技能目录 | 规则文件名 |
|---|---|
| `.claude/skills` | `CLAUDE.md` |
| `.cursor/skills` | `AGENTS.md` |
| `.agents/skills`（通用 Agent Skills / Codex） | `AGENTS.md` |

两种都存在时两个文件都生成，内容相同。下表的 `CLAUDE.md` 按此规则替换成实际文件名。

| 产物 | 来源模板 | 说明 |
|---|---|---|
| `CLAUDE.md` / `AGENTS.md` | `reference/claude-md-template.md` | 八条核心规则 + 项目信息 + 技能索引 |
| `doc/rule.doc.naming.md` | `reference/doc-naming-rule.md` | 文档命名规范，SDD 的地基 |
| `doc/guide.list.directory.md` | 见下方「文档索引怎么写」 | 人类可读的文档清单 |
| `changelogs/.gitkeep` | 空文件 | 变更记录碎片目录 |
| `doc/spec.<项目名>.md` | `reference/doc-templates.md` 的 spec 模板 | 第一份文档，让用户有地方下笔 |

生成 `CLAUDE.md` 时要做的替换：

- `{{PROJECT_NAME}}` → 目录名或用户给的项目名
- `{{PROJECT_ONE_LINER}}` → 第二步问到的一句话
- `{{DOC_DIR}}` → `doc` 或 `docs`
- `{{BUILD_COMMANDS}}` → 从 `package.json` scripts / `pyproject.toml` 探测出的真实命令；探测不到就写「（待补：本项目的构建/测试命令）」，**不要编造**
- `{{SKILL_INDEX}}` → 用第一步探测到的技能列表生成表格，每行「技能名 | 触发词 | 一句话用途」。这张表是用户认识自己手上有什么的唯一入口，四条硬要求：

  1. **触发词从 SKILL.md 正文头部那行 `**触发**：` 取**，不要用技能目录名去猜。猜出来一半是错的——`preview-url` 的触发词是 `/preview` 不是 `/preview-url`，`risk-matrix` 是 `/risk`，`doc-writer` 是 `/doc`，`flow-trace` 是 `/trace`。正文里找不到才退回 frontmatter `description` 里的触发词，再找不到才用 `/{目录名}`。
  2. **用途必须是中文**。有些技能的 `description` 是英文，直接抄进去等于没写——用一句中文概括它做什么，别原样粘英文。
  3. **frontmatter 是 YAML 折叠标量时要读完整块**。`description: >` 或 `|` 后面跟的缩进行才是正文，直接取冒号后那一段会得到一个 `>` 字符。
  4. **按用途分两组**：「日常工作」放方法论技能（需求、方案、风险、文档、验收、交接），「平台工具」放 CDS 部署运维类。产品经理在第一组里找东西，不该被部署排障技能淹没。

### 文档索引怎么写（`doc/guide.list.directory.md`）

**不要生成 `doc/README.md`**。`doc/rule.doc.naming.md`（同一次初始化就装进去了）规定该目录下每个 `.md`
都得带七种前缀之一，`README.md` 当场就违规——初始化产出的骨架自己破自己的规矩，用户第一天就学到
「规则是可以不遵守的」。索引本身是一份操作指南，走 `guide.` 前缀。

内容是一张表 + 一段怎么加新文档的说明：

```markdown
# 文档目录

> 本目录的命名规范见 `rule.doc.naming.md`。新增文档前先读它。

| 文件 | 类型 | 说明 |
|---|---|---|
| `rule.doc.naming.md` | 规范 | 文档命名规范 |
| `spec.<项目名>.md` | 规格 | 产品要做什么 |

## 新增文档

1. 选前缀：spec / design / plan / rule / guide / report / debt
2. 命名 `{前缀}.{应用名}[.{子模块}].md`
3. 建完回来在上表加一行
```

## 第四步：输出自检报告（必须，这是交付物）

生成完必须输出下面这张表，用户靠它知道自己现在站在哪：

```
SDD 初始化完成

【已生成】
  CLAUDE.md                     8 条核心规则 + 项目信息
  doc/rule.doc.naming.md        文档命名规范
  doc/guide.list.directory.md   文档索引
  doc/spec.<项目>.md             第一份需求文档（骨架）
  changelogs/                   变更记录目录

【已跳过】（文件已存在，未覆盖）
  <逐条列出>

【已装技能】<N> 个
  <技能名>  <触发词>  <一句话用途>

【缺什么】
  <按角色对照 reference/role-playbooks.md，列出该角色常用但当前没装的技能 + 下载命令>

【下一步做什么】
  1. <按角色给的第一个动作，具体到敲哪个斜杠命令>
  2. <第二个动作>
  3. <第三个动作>
```

「下一步做什么」按角色取自 `reference/role-playbooks.md`，**必须具体到用户下一句该说什么**，不能写「可以开始使用了」这种废话。

---

## 增量模式（已有 CLAUDE.md 时）

用户可能已经有自己的 `CLAUDE.md`。这时：

1. 读完现有内容
2. 只追加**缺失的**章节，用 `## SDD 工作方法（由 /sdd-init 生成）` 作为二级标题包住新增内容
3. 已有的同名规则一律以用户的为准，不改写
4. 在报告里明确说「追加了 N 节，保留了你原有的全部内容」

## 硬约束

- **不覆盖**：任何已存在的文件都跳过，只在报告里列出。用户的东西比模板重要。
- **不编造**：探测不到构建命令就写「待补」，不要猜一个 `npm start` 填上去。
- **不装样子**：报告里的「下一步」必须是能立刻敲的具体命令。
- **不加 emoji**：所有生成内容禁止 emoji 字符，状态和重要程度用文字分级表达。

## 参考文件

| 文件 | 内容 |
|---|---|
| `reference/claude-md-template.md` | CLAUDE.md 模板（八条核心规则） |
| `reference/doc-naming-rule.md` | doc/ 七类前缀命名规范 |
| `reference/doc-templates.md` | 七类文档各自的骨架模板 |
| `reference/role-playbooks.md` | 各角色的技能清单、第一步动作、典型工作流 |
