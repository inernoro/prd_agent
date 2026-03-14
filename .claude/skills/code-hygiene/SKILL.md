---
name: code-hygiene
description: Audits code for post-migration residue and technical debt across 9 dimensions (dead fields, dead branches, compat shims, naming artifacts, redundant params/types, stale comments, migration guards, over-abstraction, near-duplicates). Outputs a structured report with auto-fix plan. Trigger words: "代码卫生", "清理残留", "hygiene", "代码体检", "/hygiene".
---

# Code Hygiene — 代码卫生审计

> **迁移完成 ≠ 功能能跑。迁移完成 = 代码里看不出曾经迁移过。**

## 目录

- [适用场景](#适用场景)
- [九类检测维度](#九类检测维度mece)
- [执行流程](#执行流程)
- [输出模板](#输出模板)
- [端到端示例](#端到端示例)
- [安全规则与注意事项](#安全规则与注意事项)
- [技能协作](#技能协作)

## 适用场景

| 场景 | 例子 |
|------|------|
| **迁移后清理** | Provider→Platform 重命名完成后，扫描残留引用 |
| **重构后审计** | 架构重构后检查死代码和过时抽象 |
| **定期体检** | 每月/每季度跑一次，防止技术债累积 |
| **PR 审查辅助** | 大 PR 合入后，扫描是否引入了不必要的兼容层 |
| **新人接手** | 接手陌生模块前，先做一次卫生审计了解技术债 |

## 九类检测维度（MECE）

所有代码卫生问题归入以下 9 类，不重叠、不遗漏。

| # | 维度 | 一句话定义 | 典型信号 |
|---|------|-----------|---------|
| ① | **死字段** | 类型中定义了但无代码读写 | `// TODO`、空初始值 `= {}` |
| ② | **死条件分支** | 分支永不执行或返回空值 | `case 'x': return null;` |
| ③ | **兼容垫片** | 旧名称/旧配置的 fallback | `NEW || OLD`、`legacy` 注释 |
| ④ | **命名残留** | 代码中仍用旧概念名称 | `providerConfig` vs `platformConfig` |
| ⑤ | **冗余参数/类型** | 声明了但从未使用 | `_` 前缀参数、孤立类型导出 |
| ⑥ | **过时注释** | 注释与代码行为不符 | 已完成的 TODO、过时 JSDoc |
| ⑦ | **防御性迁移代码** | 旧数据格式的运行时填充 | `// v1 compat`、批量 `if (!field)` |
| ⑧ | **过度抽象** | 只有一个调用者的 helper/wrapper | 单次调用的 `xxxUtils` |
| ⑨ | **近似重复** | 两段 80%+ 相同的代码 | 复制粘贴仅改部分 |

**每个维度的详细信号和修复策略** → 见 [reference/dimensions.md](reference/dimensions.md)

## 执行流程

复制此 checklist 跟踪进度：

```
审计进度：
- [ ] Phase 1: 确定扫描范围
- [ ] Phase 2: 建立检测上下文
- [ ] Phase 3: 逐维度扫描（9/9）
- [ ] Phase 4: 分类评估
- [ ] Phase 5: 输出报告
- [ ] Phase 6: 用户确认后自动修复
- [ ] Phase 7: 编译/测试验证
```

### Phase 1: 确定扫描范围

```
用户输入 "/hygiene src/services"
  ├─ 指定了路径 → 扫描该路径
  ├─ 指定了模块名 → 扫描该模块目录
  └─ 未指定 → 询问用户
```

统计文件数和行数。超过 50 文件或 5000 行时，建议分模块扫描。

### Phase 2: 建立检测上下文

1. 从 CLAUDE.md「已废弃概念」获取旧名→新名映射
2. `git log --oneline --all --grep="migrate\|rename\|refactor\|deprecat" | head -20`
3. 识别项目语言，选择对应检测策略

### Phase 3: 逐维度扫描

按 9 个维度逐一扫描。**每个维度完成后立即记录发现**，使用 Agent 工具并行搜索以提高效率。

### Phase 4: 分类评估

对每个发现评估 4 个维度：

| 维度 | 选项 |
|-----|------|
| **确定性** | 确认 / 疑似 / 需人工确认 |
| **影响范围** | 本文件 / 跨文件 / 跨模块 |
| **修复难度** | 直接删除 / 需重构 / 需数据迁移确认 |
| **自动修复** | 可自动 / 需人工 |

### Phase 5–7: 输出报告 → 确认 → 修复 → 验证

输出报告格式见下方模板。用户确认后执行自动修复，每批修复后编译+测试验证。

## 输出模板

```markdown
# 代码卫生审计报告

> **扫描范围**: [路径] | **文件/行数**: N 文件, M 行 | **语言**: TypeScript

## 摘要

| 维度 | 发现 | 可自动修复 | 需确认 |
|------|------|-----------|--------|
| ① 死字段 | 2 | 2 | 0 |
| ② 死分支 | 1 | 1 | 0 |
| ... | ... | ... | ... |
| **合计** | **N** | **N** | **N** |

## 发现详情

### ①-1. `sharedEnv` — types.ts:206

- **代码**: `sharedEnv: Record<string, string>`
- **证据**: 定义于 types.ts:206，初始化为 `{}` (config.ts:12)，从未被业务逻辑消费
- **确定性**: 确认死代码
- **修复**: 删除字段定义 + 所有初始化位置
- **自动修复**: ✅

## 修复计划

### 可自动修复（N 项）

| # | 操作 | 文件 | 变更 |
|---|------|------|------|
| 1 | 删除死字段 `sharedEnv` | types.ts, config.ts | -8 行 |

### 需人工确认（N 项）

| # | 问题 | 原因 | 建议 |
|---|------|------|------|
| 1 | state.ts 迁移守卫 | 无法确认生产数据完整性 | 标记 @migration-guard |

## 执行确认

是否执行自动修复？
```

## 端到端示例

**输入**: 用户说 `/hygiene prd-admin/src/stores/`

**Phase 1**: 扫描 `prd-admin/src/stores/`，共 8 文件、1200 行 TypeScript

**Phase 2**: 从 CLAUDE.md 获取废弃映射：`Provider → Platform`、`ImageMaster → VisualAgent`

**Phase 3 扫描结果**:

- **④ 命名残留**: `sessionStore.ts:42` — 变量 `providerList` 应为 `platformList`
- **⑥ 过时注释**: `chatStore.ts:15` — `// TODO: 支持 Guide 模式` — Guide 已废弃
- **⑦ 防御性迁移**: `themeStore.ts:88` — `if (!state.glassEnabled) state.glassEnabled = false` — 液态玻璃已全量上线

**Phase 4 评估**:

| # | 维度 | 确定性 | 自动修复 |
|---|------|--------|---------|
| 1 | ④ 命名残留 | 确认 | ✅ 重命名 |
| 2 | ⑥ 过时注释 | 确认 | ✅ 删除 |
| 3 | ⑦ 迁移代码 | 确认 | ✅ 删除 |

**Phase 5 报告**: 3 项发现，3 项可自动修复，0 项需确认

**Phase 6**: 用户确认 → 执行修复 → `pnpm tsc --noEmit` 通过 → 按维度分 commit

## 安全规则与注意事项

**自动修复安全规则**：
1. 只删确认的死代码 — 疑似的标记为"需人工确认"
2. 每批修复后编译/类型检查（`tsc --noEmit` 或 `dotnet build`）
3. 每批修复后跑测试
4. 按维度分 commit，方便 revert
5. 不碰数据库 — DB 集合名/字段名的重命名需单独迁移计划

**边界判断**：
- `// reserved` / `// @planned` 标注的字段 → 不算死字段，但确认计划是否仍有效
- 公开 API / 环境变量别名 → 删除前需通知用户
- `?? []` 类防御性代码 → 可能是合理的空值保护，不应为了干净而削弱健壮性
- 测试文件中的 mock/helper → 也需要扫描

## 技能协作

```
/hygiene（发现问题）
  ├─ 命名残留 → Grep 全局替换
  ├─ 过度抽象 → /trace 追踪调用链确认
  ├─ 迁移代码 → /verify 验证数据完整性
  ├─ 修复完成 → /simplify 复审质量
  └─ 修复 3+ 文件 → /handoff 生成交接清单
```
