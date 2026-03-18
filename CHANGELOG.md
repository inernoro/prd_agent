# 更新记录

> 记录 PRD Agent 全栈项目的所有变更。版本发布时自动插入版本标记行。
>
> **格式规范**：见底部 [维护规则](#维护规则)。

---

## [未发布]

### 2026-03-18

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | cds | ClawHub 暖色调仅亮色模式：H27° 暖米背景、暖褐文字、朱红 accent、海沫绿 success、alpha 透明度边框/阴影、径向暖光晕；暗色模式保持原翡翠绿方案不变（tag: pre-clawhub-theme 可还原） |
| fix | cds | 白天模式颜色修复：背景纯白、饱和度提升、modal/日志面板适配、accent 颜色加深 |
| fix | cds | 重新部署时立即清除之前的拉取/部署错误信息（前后端同步清除） |
| feat | cds | 主题切换按钮移至顶部栏，View Transition API 水波纹动效（圆形clip-path扩散），暗色 #131314/#1E1F20、亮色 #FFFFFF/#F0F4F9 |
| feat | cds | 容器容量检查：部署前校验 (内存GB-1)*2 上限，超限弹窗提供"我偏要/停掉最早的/取消"三选项 |
| feat | cds | 无默认分支时自动选中 main/master 作为默认分支 |
| feat | prd-desktop | 缺陷管理列表行补充缺陷编号和截图缩略图显示 |
| feat | prd-desktop | 缺陷列表视图改为单行紧凑布局（对齐 web 端），新增图片预览缩略图及全屏预览 |
| feat | prd-admin | 缺陷列表视图新增图片预览缩略图（状态列左侧），支持 hover 高亮和点击全屏预览 |
| fix | prd-admin | 缺陷列表头部漏光修复：改用 surface-inset 统一样式 |
| fix | prd-admin, prd-desktop | 缺陷管理默认视图改为列表模式，视图切换按钮列表优先 |
| feat | prd-desktop | 缺陷详情面板合并优化：双栏布局、截图画廊+lightbox、[IMG]标签解析、验收/关闭/删除操作、内嵌弹窗替代prompt()、角色标识 |
| feat | prd-desktop | 新增 Tauri 命令：verify_pass_defect、verify_fail_defect、close_defect、delete_defect |

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
