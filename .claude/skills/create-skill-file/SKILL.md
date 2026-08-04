---
name: create-skill-file
version: 1.0.0
description: 'Creates and evaluates Claude Code SKILL.md files following Anthropic best practices. Generates well-structured skills with correct frontmatter, progressive disclosure, and quality validation. Trigger words: "创建技能", "新建 skill", "create skill", "技能评分", "skill score", "/create-skill".'
---

# 技能创建与质量评估

> **版本**：v1.0.0 | **状态**：已落地 | **触发**：`/create-skill`、"创建技能"、"新建 skill"、"技能评分"、"skill score"

创建高质量的 SKILL.md 文件，或对现有技能进行质量评分和改进建议。

## 目录

- [适用场景](#适用场景)
- [创建流程](#创建流程)
- [质量评分体系](#质量评分体系)
- [结构规范](#结构规范)
- [常见反模式](#常见反模式)

## 适用场景

| 场景 | 触发 |
|------|------|
| **从零创建技能** | "帮我创建一个 XXX 技能" |
| **评分现有技能** | "评估一下 /hygiene 技能" |
| **批量审计** | "扫描所有技能的质量" |
| **优化改进** | "这个技能怎么改进" |

## 创建流程

```
创建进度：
- [ ] Step 1: 明确技能定位
- [ ] Step 2: 设计 frontmatter
- [ ] Step 3: 编写主体
- [ ] Step 4: 拆分子文件（如需要）
- [ ] Step 5: 质量评分自检
- [ ] Step 6: 确认可被发现（frontmatter 完整）
```

### Step 1: 明确技能定位

回答三个问题：
1. **Claude 不知道什么？** — 只添加 Claude 不具备的项目/领域特有知识
2. **自由度多高？** — 容错低用精确指令，容错高给指导原则
3. **多复杂？** — 单文件（<200行）还是需要拆分子文件

### Step 2: 设计 frontmatter

```yaml
---
name: my-skill-name        # 小写+连字符, ≤64字符, 与目录名一致
description: ...            # 第三人称, ≤1024字符, 包含 what + when + 触发词
---
```

**name 规范**：
- 推荐动名词：`processing-csv`, `analyzing-code`
- 可接受名词短语：`code-hygiene`, `risk-matrix`
- 禁止：`helper`, `utils`, `manager`, 含 `anthropic`/`claude`

**description 4C 原则**：
- **Clear** — 避免术语
- **Concise** — 1-2 句核心功能
- **Contextual** — 说明适用场景
- **Complete** — 功能 + 触发条件

### Step 3: 编写主体

必须包含的章节：

| 章节 | 必须 | 说明 |
|------|------|------|
| 适用场景 | 必须 | 3-5 个触发场景 |
| 执行流程/工作流 | 必须 | 清晰的步骤，复杂任务用 checklist |
| 输出模板 | 推荐 | 让 Claude 知道输出什么格式 |
| 示例 | 必须 | 至少 1 个端到端 input→output |
| 安全规则/注意事项 | 按需 | 高风险操作必须有 |

### Step 4: 拆分子文件

```
skill-name/
├── SKILL.md                    # 主文件 <500行
└── reference/
    ├── detailed-guide.md       # 详细指南（按需加载）
    ├── templates.md            # 模板集合
    └── examples.md             # 更多示例
```

**拆分原则**：引用层级 ≤ 1 层，子文件 > 100 行时加目录

### Step 5: 质量评分自检

用下方评分体系打分。目标：**≥ 8.0/10**

### Step 6: 确认可被发现（frontmatter 完整）

技能的发现机制是 `SKILL.md` 的 frontmatter：宿主靠它自动注入，人工扫描 `.claude/skills/`
时也是读它来判断该不该用。所以「注册」这一步不是往某张表里加一行，而是确认这两个字段到位：

- `name`：与目录名一致
- `description`：写清**什么时候该用它**（触发场景 + 触发词），不是只写它是什么

自查（任何仓库都能跑，不依赖本项目脚本）：

```bash
skill_dir=".claude/skills/my-skill-name"   # 换成你的技能目录

head -5 "$skill_dir/SKILL.md"              # 应看到 name 与 description 两行
basename "$skill_dir"                      # 应与 frontmatter 里的 name 完全一致
```

`description` 自问三条：说清了**什么时候**该用它吗？包含用户会说的触发词吗？第三人称、无 XML 标签、
不超过 1024 字符吗？

<!-- 以下仅适用于 prd_agent 仓库本身；本技能被分发到其它仓库时没有这个脚本，跳过即可。 -->
本仓库另有批量闸门：`python3 scripts/doc-readability-check.py --ratchet` 的「技能 frontmatter
欠账」一项，会一次扫完所有技能根。

CLAUDE.md 里曾有一张 57 行的技能速查表，2026-08-04 随记忆文件精简删除——它与宿主自动注入
的内容重复，且已经漂移过。本仓库内**不要再往 CLAUDE.md 追加技能行**。

## 质量评分体系

### 评分维度（7 维度加权）

| # | 维度 | 权重 | 10 分标准 | 0 分标准 |
|---|------|------|----------|---------|
| 1 | **Core Quality** | 25% | description 具体含 what+when; <500行; 渐进式披露; 术语一致 | description 模糊; 超长; 全塞一个文件 |
| 2 | **Conciseness** | 20% | 只含 Claude 不知道的信息; 每段 justify token 成本 | 解释通用知识; verbose |
| 3 | **Degrees of Freedom** | 10% | 脆弱操作用精确指令; 创造性任务给指导原则 | 全部高自由度或全部低自由度 |
| 4 | **Structure & Naming** | 15% | name 规范; 第三人称; 200+行有 TOC; 引用≤1层 | name 不规范; 无 TOC; 引用过深 |
| 5 | **Workflow & Feedback** | 15% | 可复制 checklist; 执行→验证反馈循环 | 无工作流; 无验证步骤 |
| 6 | **Examples** | 10% | ≥1 个端到端 input→output 示例 | 无示例或纯抽象 |
| 7 | **Ecosystem** | 5% | frontmatter 的 description 说清触发场景; 标明上下游技能协作 | 孤立技能 |

### 评分输出模板

```markdown
## 技能质量评分：[skill-name]

| 维度 | 得分 | 说明 |
|------|------|------|
| Core Quality (25%) | N/10 | ... |
| Conciseness (20%) | N/10 | ... |
| Degrees of Freedom (10%) | N/10 | ... |
| Structure & Naming (15%) | N/10 | ... |
| Workflow & Feedback (15%) | N/10 | ... |
| Examples (10%) | N/10 | ... |
| Ecosystem (5%) | N/10 | ... |
| **加权总分** | **N/10** | |

### 改进项

| 优先级 | 问题 | 改进方案 |
|--------|------|----------|
| P0 | ... | ... |
| P1 | ... | ... |
```

## 结构规范

详细的 frontmatter 规范、目录组织模式、渐进式披露模式 → 见 [reference/structure-guide.md](reference/structure-guide.md)

## 常见反模式

| 反模式 | 问题 | 修复 |
|--------|------|------|
| **百科全书** | 包含 Claude 已知的通用知识 | 删除，只保留项目特有知识 |
| **巨无霸文件** | SKILL.md > 500 行 | 拆分到 reference/ 子文件 |
| **无出口流程** | 只有步骤，没有验证和输出模板 | 添加反馈循环和输出格式 |
| **幽灵触发** | description 过于模糊，错误激活 | 加入具体触发词和排除场景 |
| **嵌套引用** | A.md→B.md→C.md 三层引用 | 扁平化，所有子文件从 SKILL.md 直接引用 |
| **伪代码示例** | 示例用抽象占位符而非真实代码 | 替换为项目中的真实示例 |
| **Windows 路径** | 用 `\` 反斜杠 | 全部改为 `/` 正斜杠 |
