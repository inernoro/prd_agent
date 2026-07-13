# 生产发布安全 · 债务台账

> **版本**：v1.0 | **日期**：2026-07-12 | **状态**：已落地

## 总览

当前 open: 4 / paid: 1 / 总计: 5

## 债务列表

| ID | 严重度 | 创建日期 | 描述 | 触发条件 | 状态 | 备注 |
|---|---|---|---|---|---|---|
| 2026-07-12-atomic-static-release | critical | 2026-07-12 | `exec_dep.sh` 仍直接清理并解压在线静态目录，未采用 staging/current/previous 原子切换 | 下一次生产发布前 | open | 必须覆盖缺 index、缺入口资源、切换后失败自动回滚 |
| 2026-07-12-public-surface-smoke | critical | 2026-07-12 | 发布门禁缺少公网主页面及其实际 JS/CSS 资源验证 | 下一次生产发布前 | open | API/Gateway/容器健康不能替代产品表面检查 |
| 2026-07-12-release-command-compatibility | high | 2026-07-12 | `./exec_dep.sh release` 从 latest 兼容行为退化为把 release 当作版本 ref | 再次调整发布参数或执行生产发布前 | open | 需恢复兼容别名、`--help` 和参数回归测试 |
| 2026-07-12-release-forensic-ledger | high | 2026-07-12 | 当前发布证据无法确定首次把静态目录设置为 `700` 的具体进程 | 需要追责权限、替换或删除动作时 | open | 记录目录 mode/owner/hash/current/previous/首个失败阶段，并启用权限变化审计 |

## 已还的债务（归档）

| ID | 修复 PR | 修复日期 | 备注 |
|---|---|---|---|
| 2026-07-12-production-static-permission-recovery | 生产应急操作 | 2026-07-12 | 将静态目录从 `700` 恢复为 `755`；公网 `/`、入口 JS、`/health`、`/llmgw/` 均恢复 200。仅为恢复，不代表长期机制已完成 |

## 关闭条件

只有以下条件全部满足，才能把对应 open 项迁入已还归档：

1. 发布脚本使用 staging/current/previous 原子切换。
2. 在 `umask 077`、缺 index、缺入口资源、回滚场景下的自动测试进入 CI。
3. 公网页面、实际入口资源、API 和专项服务使用同一表面 smoke 验证。
4. `./exec_dep.sh release` 兼容 latest，错误输出能指出首个失败阶段。
5. 每次发布保存结构化证据，权限变化可以追溯到操作者和进程。
