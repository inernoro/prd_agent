# 分类、排序与分析规则

> 被 SKILL.md Phase 4 引用。分析和分类 PR/commit 时按需读取。

## 功能分类表

每个功能组归入以下类别之一：

| 类别 | 关键词信号 | 报告标签 |
|------|-----------|----------|
| 新功能 | feat, add, implement, 新增, 实现 | ✨ 新功能 |
| 更新/增强 | enhance, improve, update, 优化, 改进 | 🔄 更新 |
| Bug 修复 | fix, bugfix, hotfix, 修复 | 🐛 Bug 修复 |
| 重构/架构 | refactor, restructure, simplify, 重构 | 🏗️ 架构 |
| 性能优化 | perf, performance, optimize | ⚡ 性能 |
| UI/UX | ui, style, layout, design, 样式 | 🎨 UI/UX |
| 移动端 | mobile, responsive, 移动端 | 📱 移动端 |
| 桌面端 | desktop, tauri, 桌面 | 🖥️ 桌面端 |
| DevOps/测试 | test, ci, deploy, build, script | 🔧 DevOps |
| 文档 | docs, readme, 文档 | 📝 文档 |
| 安全/权限 | auth, permission, security, rbac | 🔐 权限 |
| AI 能力 | llm, model, gateway, thinking | 🧠 AI 能力 |
| 工作流 | workflow, automation, 工作流 | ⚙️ 工作流 |

## 提交类型标准

归入标准类别：`feat` / `fix` / `refactor` / `docs` / `chore` / `perf` / `ui` / `style` / `test` / `ci`。中文开头或无前缀的归入 "中文 commit / 无前缀"。

## 排序规则

在 "本周完成" 中，按以下优先级排序：

1. **新功能** — 最大最完整的功能优先（commit 数越多、影响范围越广越靠前）
2. **重大更新/增强**
3. **UI/UX 统一性改进**
4. **Bug 修复集合**（可合并为一个小节）
5. **架构/基础设施**
6. **其他改进**

## 功能主题分组（4.1）

- 同一 PR 下的所有 commit 归为一组
- 未关联 PR 的 commit 按消息关键词聚类
- 识别本周的 2~3 个主线功能（commit 数量最多的主题）

## 价值主张撰写（4.4）

每个主要功能需附带 `> **价值**：...` 引用块，用一句话从**用户/团队视角**解释功能重要性，不使用技术术语。

## 新功能详情展开（4.5）

对于分类为 "新功能" 的重大功能，展开为子列表：

- 后端架构要点
- 前端实现要点
- 关键子功能或子模块列表
- 质量保障措施（如有测试覆盖）

## 脉络图数据生成（4.6）

基于每日提交分布和功能主题分组的分析结果，为 Mermaid timeline 准备数据：

1. **筛选活跃日**：只保留当天提交数 >= 3 的日期（排除零星修补日）
2. **提取当日关键事件**：每天最多 3 个事件，从当天 commit/PR 中选取最重要的功能变更
3. **事件描述精炼**：每个事件用 <= 10 个中文字概括（Mermaid 渲染时宽度有限）
4. **按时间排序**：section 按日期升序排列

**事件筛选优先级**（同一天内）：
1. 新功能 / 完整模块上线
2. 重大架构变更
3. 重要 Bug 修复或性能优化
4. UI/UX 改进

**注意**：如果一周内活跃日不足 3 天，放宽阈值到提交数 >= 1。
