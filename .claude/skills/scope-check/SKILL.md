---
name: scope-check
version: 2.0.0
description: 只读审计当前分支的变更边界，结合默认分支、CODEOWNERS、目录边界、仓库规则和历史归属，将文件分类为 owned、shared、foreign 或 unknown。触发词：/scope-check、边界检查、越界检查。
allowed-tools: Read Bash Glob Grep
---

# 分支边界审计

> 版本：v2.0.0 | 只读，不修改文件，不阻断用户决策

## 核心原则

边界必须从目标仓库的证据推断，不能把某个产品的目录、Agent 名称或注册表当成通用事实。证据不足时标记 `unknown`，不伪装成确定结论。

## 发现基线

1. 默认分支：读取 `refs/remotes/origin/HEAD`；失败后检查实际存在的候选分支。
2. 变更范围：使用 merge-base 后的 `git diff --name-status <base>...HEAD`。
3. 规则来源：最近的 `AGENTS.md`、`CLAUDE.md`、`.cursor/rules/`、`CODEOWNERS`、贡献指南。
4. 模块边界：包清单、workspace 配置、顶层目录、构建文件和测试目录。
5. 历史归属：仅在前四项不足时，用相邻文件和近期提交辅助判断。

若仓库提供 `.agent-scope.json`，可读取以下可选字段：

```json
{
  "baseBranch": "origin/trunk",
  "owned": ["packages/feature-a/**"],
  "shared": ["packages/app/routes.*"],
  "appendOnly": ["changelog.d/**"],
  "protected": ["packages/security/**"]
}
```

配置只增强证据，不得绕过仓库更高优先级规则。

## 分类

| 分类 | 定义 | 常见证据 |
|---|---|---|
| `owned` | 本任务或本模块直接拥有 | 路径位于目标包；规则明确声明；新增配套测试 |
| `shared` | 多模块共同维护 | 路由、注册表、公共组件、根配置、依赖锁文件 |
| `foreign` | 明确属于其他模块或受保护区域 | CODEOWNERS 不同；规则禁止；与任务目标无可证明关系 |
| `unknown` | 证据不足或相互冲突 | 跨包工具、历史遗留目录、生成文件来源不明 |

## 审计步骤

1. 记录任务目标、当前分支、基线分支和 merge-base。
2. 枚举新增、修改、删除、重命名和未跟踪文件。
3. 为每个文件记录分类、证据和风险，不只靠文件名包含某个关键词。
4. 对 `shared` 检查是否满足仓库声明的 append-only 或注册约束。
5. 对 `foreign` 检查是否属于必要的跨模块契约变更；必要也仍然要显式报告。
6. 对删除、权限、迁移、依赖锁、CI、部署、密钥相关文件提高风险等级。
7. 给出可执行的拆分、补证或人工确认建议。

## 输出模板

```markdown
# 分支边界审计报告

- 任务目标：<goal>
- 当前分支：<branch>
- 基线分支：<base>
- 变更文件数：<count>
- 规则来源：<files or none>

| 文件 | 状态 | 分类 | 证据 | 风险 |
|---|---|---|---|---|

## 共享文件约束
<append-only、注册一致性、锁文件或公共契约检查>

## 结论
- owned：<count>
- shared：<count>
- foreign：<count>
- unknown：<count>
- 建议：可提交/建议拆分/需要人工确认
```

## 不可违反

1. 只读，不自动还原、移动或提交文件。
2. 不把“项目负责人”当成省略风险报告的理由。
3. 不把所有公共文件机械判为越界。
4. 不把未知强行归为 owned。
5. 不假定仓库一定围绕 Agent、Web 或单体应用组织。
