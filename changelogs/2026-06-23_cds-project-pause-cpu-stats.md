| feat | cds | 新增项目级暂停功能：一键冻结项目（拦截 webhook/自动+手动部署、停止所有运行容器、reconciler 不再重试），项目卡片变灰并显示「已暂停」，恢复后手动重新部署 |
| feat | cds | 新增项目级资源占用统计：周期采样各容器 docker stats 按项目汇总 CPU/内存 + 近 1h/24h 构建频次，卡片显示 CPU/构建频次小标签，新增可排序「资源占用」面板一键揪出并暂停作死项目（GET /api/cds-system/resource-usage） |
| fix | cds | 修复 deploy-dispatch 重试风暴根因（「7 小时前的构建还在跑」幽灵）：stale dispatch 重试加次数上限+指数退避+超龄不复活+在途构建不叠加+暂停项目跳过；首次派发时间锚点不再被重试刷新 |
