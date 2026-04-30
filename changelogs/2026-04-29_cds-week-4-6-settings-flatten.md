| refactor | cds | CdsSettingsPage 把 7 个并列 tab 重组为 3 个语义大类（接入 / 运行时 / 维护）：接入 = 概览 + 登录与认证 + GitHub 集成；运行时 = 存储后端 + 集群 + CDS 全局变量；维护 = 更新与重启。TabsList 在 trigger 之间渲染分组标题，用户 3 秒内能找到要改的设置 |
| refactor | cds | ProjectSettingsPage 把 8 个并列 tab 同样重组为 3 大类（接入 / 运行时 / 危险区）：接入 = 基础信息 + GitHub + 评论模板；运行时 = 项目环境变量 + 缓存诊断 + 统计 + 活动日志；危险区 = 删除项目 |
| refactor | cds | 全局视觉残留清理：所有页面里 `rounded-md border border-border bg-card` / `bg-muted/{20,30,40}` 等"灰底灰边堆叠"统一替换为 `cds-surface-raised cds-hairline` / `cds-surface-sunken cds-hairline`，与新视觉语言保持一致 |
