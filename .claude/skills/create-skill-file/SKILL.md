---
name: create-skill-file
description: Creates and evaluates Claude Code SKILL.md files following Anthropic best practices. Generates well-structured skills with correct frontmatter, progressive disclosure, and quality validation. Trigger words: "创建技能", "新建 skill", "create skill", "技能评分", "skill score", "/create-skill".
---

# Create Skill File — 技能创建 & 质量评估

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
- [ ] Step 6: 注册到 CLAUDE.md
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
| 适用场景 | ✅ | 3-5 个触发场景 |
| 执行流程/工作流 | ✅ | 清晰的步骤，复杂任务用 checklist |
| 输出模板 | 推荐 | 让 Claude 知道输出什么格式 |
| 示例 | ✅ | 至少 1 个端到端 input→output |
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

### Step 6: 注册到 CLAUDE.md

在「技能速查表」中添加一行。

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
| 7 | **Ecosystem** | 5% | 注册到 CLAUDE.md; 标明上下游技能协作 | 孤立技能 |

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
