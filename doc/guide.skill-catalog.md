# guide.skill-catalog — 技能百科全书 · 指南

> 完整的 Claude Code 技能索引。每个技能说明"输入什么、输出什么、什么时候用"。
>
> 维护者：在新增/删除/合并技能后，同步更新本文件和 `CLAUDE.md` 质量保障技能链。

---

## 技能总览（35 个）

| # | 分类 | 技能名 | 触发词 | 一句话说明 |
|---|------|--------|--------|-----------|
| 1 | 🔄 主流程 | skill-validation | `/validate` | 需求质量评估：8 种气味检测 + 雷同排查 + 七维度评分 |
| 2 | 🔄 主流程 | plan-first | `/plan-first` | 先出方案后动手：输出方案 → 用户确认 → 执行 |
| 3 | 🔄 主流程 | risk-matrix | `/risk` | MECE 六维度风险矩阵（正确性/兼容/性能/安全/运维/体验） |
| 4 | 🔄 主流程 | flow-trace | `/trace` | 端到端数据流路径图（大白话版 + 技术细节版） |
| 5 | 🔄 主流程 | human-verify | `/verify` | 四角度模拟人工审查（魔鬼辩护/反向验证/边界/场景） |
| 6 | 🔄 主流程 | scope-check | `/scope-check` | 分支边界审计：文件分类 + 越界检测 |
| 7 | 🔄 主流程 | cds-deploy-pipeline | `/cds-deploy` | CDS 灰度部署 + 就绪等待 + 冒烟测试全链路 |
| 8 | 🔄 主流程 | smoke-test | `/smoke` | 扫描 Controller 生成链式 curl 冒烟脚本 |
| 9 | 🔄 主流程 | preview-url | `/preview` | 分支名 → 预览地址（`分支名.miduo.org`） |
| 10 | 🔄 主流程 | task-handoff-checklist | `/handoff` | 8 维度交接清单（导航/文档/规则/测试/风险等） |
| 11 | 🔄 主流程 | weekly-update-summary | `/weekly` | git 历史 → 分类周报（中文） |
| 12 | 🔧 辅助 | conflict-resolution | `/resolve` | 合并 main 到当前分支，AI 解决冲突 |
| 13 | 🔧 辅助 | doc-writer | `/doc` | `doc/` 目录命名 + 表头格式守护，6 种标准模板 |
| 14 | 🔧 辅助 | doc-sync | `/doc-sync` | 扫描 `doc/` 自动对齐 index.yml 和目录文档 |
| 15 | 🔧 辅助 | code-hygiene | `/hygiene` | 10 维度技术债检测（死代码/垫片/残留/冗余等） |
| 16 | 🔧 辅助 | deep-trace | `/deep-trace` | 跨层接缝验证（C#→JSON→Rust→React 字段/类型/序列化） |
| 17 | 🔧 辅助 | llm-visibility | `/visibility` | LLM 调用点合规扫描（禁止空白等待原则） |
| 18 | 🔧 辅助 | cn-brief-summary | `200字总结` | 回复末尾追加 ≤200 字中文通俗总结 |
| 19 | 🔧 辅助 | create-skill-file | `/create-skill` | 生成 SKILL.md 文件 + 质量评分 |
| 20 | 🔧 辅助 | cds-project-scan | `/cds-scan` | 检测技术栈 → 生成 CDS docker-compose YAML |
| 21 | 🔧 辅助 | theme-transition | `/theme-transition` | 添加 View Transition API 圆形水波纹主题切换动效 |
| 22 | 🔧 辅助 | agent-guide | `/help` | Agent 开发新手引导（阶段跟踪 + 技能推荐） |
| 23 | 🔨 专项修复 | fix-unused-imports | — | 自动删除 TypeScript 未使用 import/变量（TS6133） |
| 24 | 🔨 专项修复 | fix-surface-styles | `/fix-surface` | 扫描修复 CSS 偏差，统一到 Surface System |
| 25 | 🔨 专项修复 | add-agent-permission | `加权限` | 新增权限：自动同步后端枚举 + 前端类型 + 角色分配 |
| 26 | 🔨 专项修复 | add-image-gen-model | `添加生图模型` | 注册新图片生成模型到后端 Config + 前端 Adapter |
| 27 | 🔨 专项修复 | update-model-size | `更新模型尺寸` | 对比官方 API 文档更新模型尺寸配置 |
| 28 | 🔨 专项修复 | release-version | `/release` | 自动检测版本 + 分析变更 + 执行 patch/minor/major 发版 |
| 29 | 🔨 专项修复 | ai-defect-resolve | `修复缺陷` | 通过缺陷链接自动化：列清单→评论→修复→验收 |
| 30 | 🔨 专项修复 | remotion-scene-codegen | `优化场景` | Remotion API 上下文 + 视频场景代码生成 |
| 31 | 📝 文档写作 | technical-documentation | — | Diátaxis 工作流 + 8 种模板（Spec/Architecture/Runbook/API/Quick Start/How-to/FAQ/Tutorial） |
| 32 | 📝 文档写作 | ui-ux-pro-max | — | 67 风格 + 96 配色 + 57 字体搭配设计系统 |
| 33 | 🧩 元技能 | find-skills | `找技能` | 搜索并推荐可安装的第三方技能 |
| 34 | 🧩 元技能 | api-debug | — | 查询真实 API 数据辅助调试 |
| 35 | 🧩 元技能 | dev-setup | `装环境` | 自动检测并安装 SDK + 执行 API 测试 |

---

## 已完成的合并/清理

### 已合并：4 个文档写作技能 → 2 个（2026-04-04）

| 原技能 | 操作 | 结果 |
|--------|------|------|
| **doc-writer** | 保留 | `doc/` 目录命名和格式守护（元数据治理） |
| **documentation-writer** | 已删除 | 合并入 `technical-documentation` |
| **technical-writing** | 已删除 | 合并入 `technical-documentation` |
| **user-guide-writing** | 已删除 | 合并入 `technical-documentation` |

### 已区分触发词：flow-trace vs deep-trace（2026-04-04）

| 技能 | 原触发词 | 新触发词 |
|------|---------|---------|
| **flow-trace** | `/trace` | `/trace`（不变，更常用） |
| **deep-trace** | `/trace` | `/deep-trace`（避免冲突） |

### 无需动作

| 技能 | 分析结果 |
|------|---------|
| add-image-gen-model vs update-model-size | 互补关系：一个新增模型，一个更新配置，保留两个 |
| fix-unused-imports vs fix-surface-styles | 各自解决特定问题，范围窄但精准，保留两个 |
| find-skills | 搜索外部技能生态，非循环引用，保留 |

---

## 主流程调用链路

```
需求阶段          方案阶段          实现阶段          验证阶段            交付阶段
   │                │                │                │                  │
   ▼                ▼                ▼                ▼                  ▼
/validate  →  /plan-first  →    编写代码    →   /verify       →   /preview
   │          /risk              │           /scope-check       /handoff
   │          /trace             │           /cds-deploy        /weekly
   │                             │           /smoke
   │                             │
   │                          可选辅助
   │                       /doc /hygiene
   │                    /visibility /resolve
   │                    /deep-trace
```

### 典型调用序列

**完整功能开发**：
```
/validate → /plan-first → (用户确认) → 编码 → /verify → /scope-check → /cds-deploy → /smoke → /preview → /handoff
```

**快速修复**：
```
编码 → /verify → /cds-deploy → /smoke
```

**周末收尾**：
```
/weekly → (自动触发 /doc-sync)
```

**重构/迁移**：
```
编码 → /deep-trace → /hygiene → /verify → /scope-check
```

---

## 维护指引

### 新增技能后

1. 在本文件「技能总览」表中添加一行
2. 在 `CLAUDE.md` 质量保障技能链的对应分类表中添加一行
3. 如果是主流程技能，更新流程链的 ASCII 图和典型调用序列
4. 运行 `/doc-sync` 同步文档索引

### 删除/合并技能后

1. 从本文件和 `CLAUDE.md` 中删除对应行
2. 检查 `CLAUDE.md` 使用指引中是否引用了被删技能
3. 检查其他技能的 SKILL.md 中是否交叉引用了被删技能
4. 运行 `/doc-sync` 同步文档索引
