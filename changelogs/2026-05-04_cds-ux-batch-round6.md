| feat | cds | UX 优化批次:主题按钮挪右上(行业标准位置 + 修左下与 GlobalUpdateBadge 重叠) |
| feat | cds | 顶栏容量加 tooltip + 单位说明:"7/186 容量" → "7/186 容器" + 详细 tooltip 解释槽位含义 |
| feat | cds | 失败/异常分支卡置顶(超越收藏优先级)+ 红色 ring + 红色染色,接班场景一秒看到异常分支 |
| feat | cds | 失败 drawer 智能默认 tab:status === error 时自动开"日志"+ 自动选中失败 service,0 click 看错误 |
| feat | cds | 删除分支二次确认增强:具体说明会停几个服务 + "不可恢复" 警示 + git 历史不受影响声明 |
| feat | cds | 失败 card 内联诊断:错误归类 chip(端口冲突/OOM/依赖缺失/进程异常退出/健康检查超时/镜像拉取)+ 责任侧 chip(代码侧/配置侧/CDS 侧)+ 最后 5 行 stderr + 查看完整日志 CTA |
| feat | cds | 新增 GET /api/branches/:id/failure-diagnosis 端点:从 docker logs 读最后 30 行 + regex 模式归类 |
| feat | cds | GlobalUpdateBadge 加 inline "立即更新" 按钮(updateAvailable 状态),不再跳 settings 页再点一次 |
| feat | cds | GitHub 关联卡片新增 "最近自动部署" mini-list:从 branch.githubInstallationId 推断,按 lastDeployAt 排序,证明 webhook 在工作 |
| feat | cds | 新增 GET /api/projects/:id/recent-auto-deploys 端点 |
| feat | cds | 顶栏右上"刷新"按钮替换为 SSE 在线状态点(绿色静止 = 实时连接中),仅在 SSE 中断时露出黄色 RefreshCw 兜底,消除"暗示数据不新鲜"的视觉噪音 |
