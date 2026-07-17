# 生产发布安全 · 债务台账

> **版本**：v1.1 | **日期**：2026-07-17 | **状态**：已落地

## 总览

当前 open: 0 / paid: 6 / 总计: 6

## 债务列表

| ID | 严重度 | 创建日期 | 描述 | 触发条件 | 状态 | 备注 |
|---|---|---|---|---|---|---|
| 无 | - | - | 当前没有未偿生产发布安全债务 | - | closed | 新缺口继续按本文件格式登记，禁止只写在提交信息中 |

## 已还的债务（归档）

| ID | 修复 PR | 修复日期 | 备注 |
|---|---|---|---|
| 2026-07-12-production-static-permission-recovery | 生产应急操作 | 2026-07-12 | 将静态目录从 `700` 恢复为 `755`；公网 `/`、入口 JS、`/health`、`/llmgw/` 均恢复 200。仅为恢复，不代表长期机制已完成 |
| 2026-07-12-atomic-static-release | 本发布稳定性收尾 PR | 2026-07-17 | `deploy/web/dist` 保持为 gateway 的稳定 bind 根；新产物在根内 `.staging-*` 离线解压、归一化和校验后进入 `.releases/`，再原子切换 `current`，`previous` 保留上一版。非 gateway 容器更新后先用当前配置原地 reload gateway 刷新上游地址，再进入长 readiness；任一强制探针失败由 EXIT trap 恢复 previous，并原地校验、reload gateway 后复验公网。inproc 回滚与 shadow 恢复路径也禁止重建 gateway。缺 index、缺入口资源、注入切换失败、中断恢复和回滚均有行为测试。 |
| 2026-07-12-public-surface-smoke | 本发布稳定性收尾 PR | 2026-07-17 | 发布后强制从公网验证主 HTML、实际同源 JS/CSS、API 版本、LLMGW 页面和 Console/Serving 双健康，并写 JSON。相同探针加入每 6 小时独立 GitHub 定时任务，能够区分页面、资源、API 与专项服务失败。 |
| 2026-07-12-release-command-compatibility | 本发布稳定性收尾 PR | 2026-07-17 | `./exec_dep.sh release` 明确映射 latest 并输出迁移提示，`--help` 同时展示兼容命令和不可变 `--commit` 推荐路径；不可变静态产物不再允许跳过 SHA256。 |
| 2026-07-12-release-forensic-ledger | 本发布稳定性收尾 PR | 2026-07-17 | 每次执行写不可覆盖 JSON，记录操作者、主机、release shell PID、开始结束时间、目标 ref、产物 URL/实际与期望 SHA256、校验结论、切换前后 owner/mode/current/previous、公网探针、首个失败阶段与回滚结果。2026-07-12 首次把目录改为 `700` 的历史进程无法追溯，属于不可恢复历史事实；后续发布已具备归因链。 |
| 2026-07-17-independent-public-surface-watch | 本发布稳定性收尾 PR | 2026-07-17 | `LLM Gateway Shadow Watch` 新增无密钥 `public-surface` 独立 job，每 6 小时复用同一公网探针并上传内容寻址检查结果，不依赖发布动作。 |

## 关闭条件

以下关闭条件已全部进入代码、行为测试或定时监控；后续若任一条件退化，必须重新登记 open：

1. 发布脚本使用 staging/current/previous 原子切换。
2. 在 `umask 077`、缺 index、缺入口资源、回滚场景下的自动测试进入 CI。
3. 公网页面、实际入口资源、API 和专项服务使用同一表面 smoke 验证。
4. `./exec_dep.sh release` 兼容 latest，错误输出能指出首个失败阶段。
5. 每次发布保存结构化证据，权限变化可以追溯到操作者和进程。
