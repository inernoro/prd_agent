# 生产发布安全 · 债务台账

> **版本**：v1.3 | **日期**：2026-08-03 | **状态**：部分落地

**一句话**：既有生产发布安全债务已经还清，CDS 双入口表面探针仍有一项待闭环。
**谁该读**：做发布评审的人；想追溯当初怎么修的人。
**读完能做什么**：确认这条线已清账，并查到各项的还债记录。

---

## 总览

当前 open: 1 / paid: 8 / 总计: 9

## 债务列表

| ID | 严重度 | 创建日期 | 描述 | 触发条件 | 状态 | 备注 |
|---|---|---|---|---|---|---|
| 2026-08-03-cds-split-surface-probe | P2 | 2026-08-03 | 生产表面探针默认假定 MAP、`/health` 与 LLM Gateway 位于同一域名；CDS 预览实际返回 MAP 与 Gateway 两个公开入口，主域名未暴露 `/health`，导致主页面、入口资源与 API 版本正常时仍误报失败 | 对 CDS 双入口预览以 MAP 模式运行生产表面探针 | open | 增加显式的 CDS 双入口拓扑参数或组合探针：主入口检查 HTML、真实 JS/CSS、`/api/version` 与目标提交；Gateway 入口检查页面、Console/Serving 健康和四协议无密钥 401。两部分都通过才判 pass，并补行为测试和真实 CDS 复测 |

## 已还的债务（归档）

| ID | 修复 PR | 修复日期 | 备注 |
|---|---|---|---|
| 2026-07-12-atomic-static-release | PR #1174 | 2026-07-17 | `deploy/web/dist` 保持为 gateway 的稳定 bind 根；新产物在根内 `.staging-*` 离线解压、归一化和校验后进入 `.releases/`，再原子切换 `current`，`previous` 保留上一版。非 gateway 容器更新后先用当前配置原地 reload gateway 刷新上游地址，再进入长 readiness；任一强制探针失败由 EXIT trap 恢复 previous，并原地校验、reload gateway 后复验公网。inproc 回滚与 shadow 恢复路径也禁止重建 gateway。缺 index、缺入口资源、注入切换失败、中断恢复和回滚均有行为测试。 |
| 2026-07-12-public-surface-smoke | PR #1174 | 2026-07-17 | 发布后强制从公网验证主 HTML、实际同源 JS/CSS、API 版本、LLMGW 页面和 Console/Serving 双健康，并写 JSON。相同探针加入每 6 小时独立 GitHub 定时任务，能够区分页面、资源、API 与专项服务失败。 |
| 2026-07-12-release-command-compatibility | PR #1174 | 2026-07-17 | `./exec_dep.sh release` 明确映射 latest 并输出迁移提示，`--help` 同时展示兼容命令和不可变 `--commit` 推荐路径；不可变静态产物不再允许跳过 SHA256。 |
| 2026-07-12-release-forensic-ledger | PR #1174 | 2026-07-17 | 每次执行写不可覆盖 JSON，记录操作者、主机、release shell PID、开始结束时间、目标 ref、产物 URL/实际与期望 SHA256、校验结论、切换前后 owner/mode/current/previous、公网探针、首个失败阶段与回滚结果。2026-07-12 首次把目录改为 `700` 的历史进程无法追溯，属于不可恢复历史事实；后续发布已具备归因链。 |
| 2026-07-17-independent-public-surface-watch | PR #1174 | 2026-07-17 | `LLM Gateway Shadow Watch` 新增无密钥 `public-surface` 独立 job，每 6 小时先验证 MAP 根页、真实资源、API 与网关双健康，再以独立 Gateway 模式验证网关产品标识、真实 JS/CSS、Console/Serving 精确提交和 GW Native、OpenAI、Claude、Gemini 四协议无密钥 401；两份 JSON 均上传保存，不依赖发布动作。 |
| 2026-07-17-static-release-umask-worker-access | PR #1176 | 2026-07-17 | 生产发布在 `umask 077` 下创建的 `.releases` 和版本根目录为 `700`，完整产物仍会被 Nginx worker 拒绝并导致根页 500。发布表面探针拒绝完成后，通过发布前静态与 Nginx 精确备份恢复根页 200，网关容器 ID/IP 保持不变。PR #1176 在原子切换前把目录固定为 `755`、文件固定为 `644`，增加严格 umask 单测、真实 Nginx worker 测试和独立 CI 门禁。 |
| 2026-08-04-gateway-bind-mount-drift | 待本次发布归档 | 2026-08-04 | 生产仓库目录被替换后，长时间运行的 gateway 仍绑定旧目录 inode，宿主机 `current` 已切换但容器继续读取旧页面。发布脚本现在以 `coherent`、`confirmed-drift`、`probe-error` 三态对账宿主机与容器内的静态指针、首页 hash 和 Nginx 配置 hash；只有确认漂移且 Compose 绝对目录真实拥有当前挂载时才定向重建 gateway，重建后再次对账。重建前后容器 ID、状态与 hash 前缀写入发布证据。公网表面探针要求实际解析出的同源 JS/CSS 入口 URL 含目标 commit，杜绝把 meta 文案当成新版入口而误放行。 |

## 关闭条件

以下关闭条件已全部进入代码、行为测试或定时监控；后续若任一条件退化，必须重新登记 open：

1. 发布脚本使用 staging/current/previous 原子切换。
2. 在 `umask 077`、缺 index、缺入口资源、回滚场景下的自动测试进入 CI。
3. 公网页面、实际入口资源、API 和专项服务使用同一表面 smoke 验证。
4. `./exec_dep.sh release` 兼容 latest，错误输出能指出首个失败阶段。
5. 每次发布保存结构化证据，权限变化可以追溯到操作者和进程。

---

## 已结清（供回溯）

下列条目台账里已自己标记为解决/交付，移到文末只为让上文只剩未还的账；内容原样保留。

### 已还的债务（归档）

| ID | 修复 PR | 修复日期 | 备注 |
|---|---|---|---|
| 2026-07-12-production-static-permission-recovery | 生产应急操作 | 2026-07-12 | 将静态目录从 `700` 恢复为 `755`；公网 `/`、入口 JS、`/health`、`/llmgw/` 均恢复 200。仅为恢复，不代表长期机制已完成 |

## 实现来源

- 生产表面探针：[prd-agent-public-surface-smoke.py](../scripts/prd-agent-public-surface-smoke.py)
