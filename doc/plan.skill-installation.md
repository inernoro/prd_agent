# Claude Code Skill 安装计划

> **创建日期**：2026-02-01
> **适用范围**：prd_agent 项目的 Claude Code 开发环境
> **参考来源**：skills.sh 深度分析报告、VibeCoding.app 评测

---

## 一、项目技术栈分析

| 层级 | 技术 | 版本 |
|------|------|------|
| **前端 (prd-admin)** | React + TypeScript + Vite | 18.3.1 |
| **状态管理** | Zustand | 5.0.1 |
| **UI 组件** | Radix UI | 各组件最新版 |
| **样式** | Tailwind CSS | 4.x |
| **测试** | Vitest | 2.1.5 |
| **桌面端 (prd-desktop)** | Tauri 2.0 (Rust) + React | 2.1.x |
| **后端 (prd-api)** | .NET 8 (C# 12) | 8.0 |
| **数据库** | MongoDB | - |

### 技术栈关键结论

| 技术 | 是否使用 | Skill 影响 |
|------|----------|------------|
| React | ✅ 是 | `vercel-react-best-practices` 适用 |
| Next.js | ❌ 否 | `next-best-practices` **不适用** |
| Supabase/PostgreSQL | ❌ 否 | `supabase-postgres-best-practices` **不适用** |
| Vite | ✅ 是 | 无专门 Skill，React 最佳实践仍适用 |
| Tauri/Rust | ✅ 是 | 暂无高质量 Skill |

---

## 二、推荐安装的 Skills

### 第一优先级：核心能力提升（必装）

#### 1. systematic-debugging
```bash
claude skill install obra/superpowers/systematic-debugging
```

| 属性 | 值 |
|------|-----|
| 来源 | obra/superpowers |
| 安装量 | 3.8K |
| 适用性 | ⭐⭐⭐⭐⭐ |

**核心价值：**
- 4 阶段系统化调试流程，强制根因分析
- 铁律："NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST"
- 3 次失败规则：如果 3 次修复都失败 → 停止并质疑架构

**解决的真实问题：**
1. 防止 AI 随机猜测修复
2. 多组件系统诊断（本项目涉及前端 + 后端 + 桌面端）
3. 识别架构问题的模式

**与项目匹配度：**
- prd_agent 是多层架构（React + .NET + Tauri），调试时需要追踪跨层数据流
- 符合 CLAUDE.md 中的"服务器权威性设计"原则

---

#### 2. test-driven-development
```bash
claude skill install obra/superpowers/test-driven-development
```

| 属性 | 值 |
|------|-----|
| 来源 | obra/superpowers |
| 安装量 | 3.5K |
| 适用性 | ⭐⭐⭐⭐⭐ |

**核心价值：**
- 强制先写失败的测试再写代码
- 与 systematic-debugging 配合使用
- 确保每个修复都有可重现的测试

**与项目匹配度：**
- 项目已使用 Vitest（prd-admin、prd-desktop）
- 符合 CLAUDE.md 中 DefectAgentTests (25 tests) 的测试规范

---

#### 3. vercel-react-best-practices
```bash
claude skill install vercel-labs/agent-skills/vercel-react-best-practices
```

| 属性 | 值 |
|------|-----|
| 来源 | vercel-labs/agent-skills |
| 安装量 | 80.1K |
| 适用性 | ⭐⭐⭐⭐⭐ |

**核心价值：**
- 57 条具体规则，跨越 8 个类别，按影响优先级排序
- 每条规则包含：错误示例、正确示例、原因解释
- 由 Vercel 工程团队维护，基于生产环境经验

**关键规则（适用于本项目）：**

| 规则 | 优先级 | 与项目关联 |
|------|--------|-----------|
| `async-parallel` | CRITICAL | 优化 API 并发调用 |
| `async-defer-await` | CRITICAL | 减少 SSE 流处理延迟 |
| `bundle-barrel-imports` | CRITICAL | 避免桶文件导入，减少包体积 |
| `bundle-dynamic-imports` | CRITICAL | 懒加载重组件（如 ECharts、Lexical） |
| `server-cache-react` | HIGH | React.cache() 去重请求 |

**注意事项：**
- 部分规则针对 Next.js（如 Server Components），本项目使用 Vite，需选择性应用
- 核心的异步优化、Bundle 优化规则仍然适用

---

### 第二优先级：工作流增强（推荐）

#### 4. writing-plans
```bash
claude skill install obra/superpowers/writing-plans
```

| 属性 | 值 |
|------|-----|
| 来源 | obra/superpowers |
| 安装量 | 3.3K |
| 适用性 | ⭐⭐⭐⭐ |

**核心价值：**
- 强制 AI 先制定计划再执行
- 计划可保存为 Markdown 文件供审查
- 支持中断后恢复

**与项目匹配度：**
- 项目已有 `doc/plan.*.md` 的计划文档规范
- 适合复杂的跨模块重构任务

---

#### 5. executing-plans
```bash
claude skill install obra/superpowers/executing-plans
```

| 属性 | 值 |
|------|-----|
| 来源 | obra/superpowers |
| 安装量 | 2.7K |
| 适用性 | ⭐⭐⭐⭐ |

**核心价值：**
- 与 writing-plans 配合，执行阶段的指导
- 支持计划的增量执行和进度追踪

---

## 三、明确不安装的 Skills

### 1. next-best-practices
```
# 不安装
# claude skill install vercel-labs/next-skills/next-best-practices
```

**原因：** 项目使用 Vite，不使用 Next.js。规则中的 Server Components、App Router、Metadata API 等概念不适用。

---

### 2. supabase-postgres-best-practices
```
# 不安装
# claude skill install supabase/agent-skills/supabase-postgres-best-practices
```

**原因：** 项目使用 MongoDB，不使用 Supabase/PostgreSQL。RLS、PostgreSQL 索引策略等规则不适用。

---

### 3. 泛化的"代码质量"类 Skills
**原因：** 根据分析报告，80% 的 skills.sh 技能是低质量的。避免安装：
- 只是重述 AI 默认行为的技能
- 没有具体代码示例的技能
- 与官方文档冲突的技能

---

## 四、安装执行计划

### Phase 1：核心 Skills 安装

```bash
# 1. 安装调试能力
claude skill install obra/superpowers/systematic-debugging

# 2. 安装 TDD 支持
claude skill install obra/superpowers/test-driven-development

# 3. 安装 React 最佳实践
claude skill install vercel-labs/agent-skills/vercel-react-best-practices
```

### Phase 2：工作流 Skills 安装

```bash
# 4. 安装计划制定能力
claude skill install obra/superpowers/writing-plans

# 5. 安装计划执行能力
claude skill install obra/superpowers/executing-plans
```

### Phase 3：验证安装

```bash
# 查看已安装的 skills
claude skill list

# 验证特定 skill 是否生效
claude skill show systematic-debugging
```

---

## 五、使用注意事项

### 1. 上下文窗口管理
每个 Skill 都会占用 AI 的上下文窗口。**建议总数不超过 5 个**，以避免：
- 规则冲突
- 上下文污染
- 响应质量下降

### 2. 规则优先级
当 Skill 规则与 CLAUDE.md 冲突时，**CLAUDE.md 优先**。

例如：
- vercel-react-best-practices 可能建议 Server Components
- CLAUDE.md 未使用 Next.js，应忽略此建议

### 3. 定期评估
每季度评估一次 Skill 的实际效用：
- 是否真正提升了代码质量？
- 是否与项目架构匹配？
- 是否有更新版本？

---

## 六、Skill 与 CLAUDE.md 的协同

| CLAUDE.md 原则 | 对应 Skill | 协同方式 |
|----------------|------------|----------|
| LLM Gateway 统一调用 | systematic-debugging | 调试时追踪 Gateway 层 |
| 服务器权威性设计 | test-driven-development | 测试断线重连场景 |
| 前端架构原则（单一数据源） | vercel-react-best-practices | 状态管理最佳实践 |
| Run/Worker 模式 | systematic-debugging | 多组件系统诊断 |

---

## 七、快速参考卡片

### 安装命令（复制使用）

```bash
# 全部安装（推荐顺序）
claude skill install obra/superpowers/systematic-debugging
claude skill install obra/superpowers/test-driven-development
claude skill install vercel-labs/agent-skills/vercel-react-best-practices
claude skill install obra/superpowers/writing-plans
claude skill install obra/superpowers/executing-plans
```

### 已安装 Skills 清单

| # | Skill | 来源 | 用途 |
|---|-------|------|------|
| 1 | systematic-debugging | obra/superpowers | 系统化调试 |
| 2 | test-driven-development | obra/superpowers | 测试驱动开发 |
| 3 | vercel-react-best-practices | vercel-labs | React 最佳实践 |
| 4 | writing-plans | obra/superpowers | 计划制定 |
| 5 | executing-plans | obra/superpowers | 计划执行 |

---

## 八、参考资料

- [skills.sh](https://skills.sh/) - Skill 市场
- [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) - Vercel 官方 Skills
- [obra/superpowers](https://github.com/obra/superpowers) - Jesse Obra 的 Superpowers 套件
- [VibeCoding.app 评测](https://vibecoding.app/) - Skill 质量评估
