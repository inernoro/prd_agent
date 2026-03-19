# 更新记录

> 记录 PRD Agent 全栈项目的所有变更。版本发布时自动插入版本标记行。
>
> **格式规范**：见底部 [维护规则](#维护规则)。

---

## [未发布]

### 2026-03-18

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-desktop | 缺陷管理列表行补充缺陷编号和截图缩略图显示 |
| feat | prd-desktop | 缺陷详情面板合并优化：双栏布局、截图画廊+lightbox、[IMG]标签解析、验收/关闭/删除操作、内嵌弹窗替代prompt()、角色标识 |
| feat | prd-desktop | 新增 Tauri 命令：verify_pass_defect、verify_fail_defect、close_defect、delete_defect |
| feat | prd-api | 周报创建接口新增 creationMode（manual/ai-draft），支持创建后自动调用大模型生成草稿并保持 Draft 状态；新增“我的 AI 数据源”接口（默认日常记录+MAP平台工作记录），并将 MAP 开关接入 AI 草稿上下文 |
| feat | prd-admin | 周报创建卡片新增“手动填写/AI生成周报草稿”双入口，AI 模式直接回填生成内容并保留失败降级提示，编辑页文案升级为“AI重新生成草稿”并替换原生 confirm 为系统确认弹窗，详情页/详情弹窗评论输入框改为当前板块内就地展开；“我的数据源”改为先展示默认两项并支持 MAP 开关，个人扩展源移除 GitLab |
| chore | scripts | 优化 Cloud Agent 启动环境：预热 prd-admin pnpm 缓存、统一 pnpm 安装策略，并在启动阶段验证 `dotnet build prd-api` 与 `pnpm -C prd-admin tsc --noEmit` |

### 2026-03-17

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-api | 修复 SSE 流占位消息跳过发送者信息解析导致机器人头像显示为默认头像 |
| fix | prd-desktop | 修复群列表右键菜单非群主也显示"解散该群"的问题，改为仅群主可见 |

### 2026-03-16

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-desktop | 移植缺陷管理列表页面从管理后台到桌面客户端 |

### 2026-03-15

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-desktop | 群组管理功能：解散群、退出群、添加成员、系统消息展示 |

### 2026-03-14

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-api | CDS 重启时仅终止 node/tsx 进程，避免误杀其他端口占用者 |
| fix | prd-api | 解决 CDS 重启端口冲突（EADDRINUSE） |

### 2026-03-13

| 类型 | 模块 | 描述 |
|------|------|------|
| docs | doc | 新增周报功能完整操作指南 |
| refactor | doc | 重命名 research.ai-report-systems → design.ai-report-systems |

### 2026-03-12

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-admin | 团队周报 UX 改进：设置页使用 GlassCard、分支卡片三区布局重设计 |
| fix | prd-admin | CDS 分支卡片移除多余标签，修复布局问题 |

---

## 维护规则

### 记录格式

```markdown
### YYYY-MM-DD

| 类型 | 模块 | 描述 |
|------|------|------|
| feat/fix/refactor/docs/perf/chore | 模块名 | 一句话描述 |
```

### 类型定义

| 类型 | 含义 |
|------|------|
| `feat` | 新功能 |
| `fix` | 缺陷修复 |
| `refactor` | 重构（不改变外部行为） |
| `docs` | 文档变更 |
| `perf` | 性能优化 |
| `chore` | 构建/工具/依赖变更 |

### 模块名

`prd-api` · `prd-desktop` · `prd-admin` · `prd-video` · `doc` · `scripts` · `infra`

### 合并规则

- 同一天、同一类型、同一模块的多条变更合并为一条，用顿号分隔要点
- 例：`feat | prd-desktop | 群组管理：解散群、退出群、添加成员`

### 版本发布标记

发布版本时，将 `[未发布]` 下的条目包裹进版本号标题：

```markdown
## [1.7.0] - 2026-03-20

> 🚀 **用户更新项**
> - 新增群组管理功能（解散群、退出群、添加成员）
> - 修复机器人头像显示为默认头像的问题
> - 桌面端新增缺陷管理列表

### 2026-03-17
...（原有日条目保留）

---

## [未发布]
（新的未发布条目从这里开始）
```

版本标题下的 `用户更新项` 区块用于：
1. Tauri 自动更新弹窗的 `body` / `notes` 展示
2. GitHub Release Notes
3. 内部通知 / 群公告
