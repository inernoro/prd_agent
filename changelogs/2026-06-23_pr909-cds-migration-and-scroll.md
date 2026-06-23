| feat | cds | 新增 CDS 项目迁移(项目设置「迁移」Tab):一键导出本项目 cds-compose 配置 + dry-run 预演 + merge 推送到另一个 CDS 节点复刻部署;迁移目标(CdsPeer)管理 + 连接测试;数据迁移只读扫描 + 备份/恢复手动桥接。补回早已丢失的迁移路由层(state/类型/API label 尚在,处理器与 UI 缺失) |
| feat | cds | 迁移「添加目标」可填目标节点自己的 Access Key;留空回退本机 key(同时读 process.env 与 Dashboard 全局变量 AI_ACCESS_KEY) |
| security | cds | 迁移仅限人类管理员(CDS cookie 或 GitHub 会话):AI 会话/项目级或全局 Agent Key/静态 AI_ACCESS_KEY 一律 403,杜绝非人类调用方诱导服务端把 bootstrap key 外泄;远端只用 merge(不做 replace-all,避免清空目标其它项目配置) |
| fix | cds | 迁移 Tab 健壮性:跨项目切换 stale-guard(防别项目 cds-compose+明文 env 串显)、加载失败不再无限转圈、verify/replicate/data-plan 统一带回退 key 鉴权(修空 key peer 推送 401) |
| fix | cds | 修复 CDS 系统设置/项目设置长页(如「更新与重启」)滚动条默认隐藏、看似滑不动:壳 h-screen 固定 + 内容区 .cds-main 自身 overflow-y:auto + scrollbar-gutter:stable + 全局 ::-webkit-scrollbar 常驻可见非 overlay,顶栏/左导航钉住 |
| fix | prd-admin | 修复更新中心空数据渲染崩溃:releases/fragments/days/entries/highlights 全面补空值保护,避免整页跌入错误边界;更新中心滚动区加 .clg-scroll 常驻可见滚动条 |
| fix | cds | 迁移「节点地址」输入框默认值由 noroenrn.com(测试残留)改为空,仅保留 placeholder,避免误添加错误目标 |
| fix | cds | 迁移连接测试/数据扫描探活改用 import-config dryRun(复刻真正会打的端点)而非 /api/me:后者在 github-auth 远端无 cookie 会 401、auth-disabled 远端无脑 200,都无法证明 key 有效;/api/me 仅降级为取友好名(PR #909 Bugbot) |
| fix | cds | 迁移 guard 在 CDS_AUTH_MODE=disabled(开放面板)下放行:该模式无 cookie/session 标记且本无安全边界,否则迁移整页 403 不可用(PR #909 Codex P2) |
