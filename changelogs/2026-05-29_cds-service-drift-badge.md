| feat | cds | 分支卡新增「服务漂移」徽标 + 一键收敛:期望态(项目全部 build profile)vs 实际态(branch.services 快照)做 diff,缺失/异常服务在卡片上点名显示,点击按最新构建配置重新部署补齐(走 /deploy 而非 force-rebuild) |
| fix | cds | computeServiceDrift 纯函数 SSOT 落 deploy-runtime.ts,根治"项目加了 profile 但已部署分支不回灌、UI 只显示数量看不出少了谁"的快照漂移盲区 |
