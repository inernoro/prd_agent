# 技能结构详细规范

> 被 SKILL.md 引用。包含 frontmatter 规范、目录组织、渐进式披露模式。

## YAML Frontmatter 规范

| 字段 | 要求 | 约束 |
|------|------|------|
| `name` | 必填 | 小写字母+数字+连字符, ≤64字符, 与目录名一致 |
| `description` | 必填 | 纯文本, ≤1024字符, 无 XML 标签 |

**name 禁忌**：
- XML 标签、保留字 (`anthropic`, `claude`)
- 模糊词 (`helper`, `utility`, `manager`)
- 空格或下划线（用连字符 `-`）

**description 技巧**：

```yaml
# ❌ 过于泛化
description: Helps with code tasks

# ✅ 具体+触发场景
description: Analyzes Python code for security vulnerabilities using bandit. Activates when user mentions "security audit" or "vulnerability scan".

# ✅ 中英双语触发词
description: Audits code for post-migration residue. Trigger words: "代码卫生", "hygiene", "/hygiene".
```

## 目录组织模式

### 简单技能（<200行）

```
skill-name/
└── SKILL.md
```

### 标准技能（200-500行主文件）

```
skill-name/
├── SKILL.md              # 主指令 + 摘要表 + 流程 + 示例
└── reference/
    ├── detailed-guide.md  # 详细检测/操作指南
    └── templates.md       # 输出模板集合
```

### 复杂技能（需要脚本）

```
skill-name/
├── SKILL.md
├── reference/
│   └── api-reference.md
└── scripts/
    ├── analyze.py         # 分析脚本
    └── validate.py        # 验证脚本
```

## 渐进式披露三层模型

```
Layer 1: YAML frontmatter (name + description)
  ↓ 始终加载到系统提示
  ↓ Claude 用它决定是否激活技能

Layer 2: SKILL.md body
  ↓ 技能激活时加载
  ↓ 包含执行指令、摘要、流程

Layer 3: reference/*.md + scripts/
  ↓ 按需加载
  ↓ SKILL.md 中用相对路径引用
```

**关键原则**：
- 引用层级 ≤ 1 层（SKILL.md → reference/xxx.md，不能再套一层）
- 子文件 > 100 行时在开头加目录
- 文件名要有语义（`form-validation-rules.md` 而非 `doc2.md`）

## 内容编写原则

### 只添加 Claude 不知道的信息

```markdown
# ❌ 过度详细（Claude 已知）
1. 创建 Python 文件
2. 导入必要的库
3. 定义函数

# ✅ 简洁有效（项目特有）
使用 `scripts/api_client.py` 调用内部 API。
请求头必须包含 `X-Internal-Token`（从环境变量获取）。
```

### 自由度匹配矩阵

| 自由度 | 适用场景 | 编写方式 |
|--------|---------|---------|
| **高** | 创造性任务、多种解法 | 指导原则，不限定步骤 |
| **中** | 有推荐模式但允许变化 | 参数化示例 + 默认流程 |
| **低** | 容易出错、需严格执行 | 详细分步指令或脚本 |

### 工作流 Checklist 模式

复杂任务（3+ 步骤）必须提供可复制的 checklist：

```markdown
复制此 checklist 跟踪进度：

```
Task Progress:
- [ ] Step 1: 分析输入
- [ ] Step 2: 处理数据
- [ ] Step 3: 验证结果
- [ ] Step 4: 输出报告
```
```

### 反馈循环模式

关键操作后必须验证：

```markdown
1. 执行修改
2. 运行验证：`tsc --noEmit` / `dotnet build`
3. 如果失败 → 修复 → 回到步骤 2
4. 验证通过 → 继续
```

## 项目特有规范

本项目技能的额外要求：

1. **注册到 CLAUDE.md**：在「技能速查表」添加一行
2. **中英双语**：description 用英文（提升跨平台发现率），触发词包含中文
3. **技能协作**：标明与其他技能的上下游关系
4. **输出模板**：必须给出报告/结果的 Markdown 模板
