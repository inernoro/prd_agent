# 本地 48 小时自动化提示词

自动化名称：`stable-smoke-48h`

执行环境：`local`

工作目录：`/Users/inernoro/project/prd_agent`

调度：`RRULE:FREQ=DAILY;INTERVAL=2;BYHOUR=2;BYMINUTE=17`

## 提示词正文

在项目主工作区执行 `/稳测 all`。CDS 是独立的 CDS 环境，入口只能由项目 `preview-url` 权威命令读取；正式环境固定为 `https://map.ebcone.net`。禁止使用“测试环境”称呼 CDS，禁止创建或调用 GitHub Actions 调度。

每轮先生成唯一 runId，并使用该 runId 执行 `node scripts/stable-smoke-run.mjs --dry-run --run-id <runId>`，冻结本轮 commit、取证起点和 `visual-plan.json`。随后必须调用 `/验收`，使用 `create-visual-test-to-kb` 的真人浏览器 harness 按视觉计划逐项从可见导航进入页面，在 CDS 环境与正式环境采集桌面端、真实触控移动端及适用主题证据，输出与本轮 runId、commit 完全一致的 `manifest.json`。最后执行 `node scripts/stable-smoke-run.mjs --run-id <runId> --visual-manifest <manifest.json绝对路径>`。不得省略取证步骤，不得把 Playwright 普通附件或空数组冒充视觉清单；manifest 缺失时本轮必须阻断并通知。

启动时检查 `.env.stable-smoke.local` 是否存在并安全装载，不打印任何密钥、密码、token 或一次性登录票据。使用本地互斥锁避免重复运行；若上一轮仍在执行，记录本轮为 `conditional` 并退出。

按业务功能台账固定全部功能线和 active 永久回归。先执行 CDS 环境完整矩阵，再执行正式环境安全矩阵。CDS 环境出现 P0、数据污染或清理失败时，正式环境只做只读检查。每个失败最多重试一次，重试通过仍记为 flaky。

计划和执行必须保留测试矩阵的 CDS、正式两列策略，分别生成必跑 caseId 和 Playwright grep；正式环境禁止重新纳入“不主动”“不改正式配置”的动作，模块轮换项按本轮固定 commit 确定性选择一条。人工 `--grep` 只能取本环境允许集合的交集。

本地产物写入 `/tmp/prd-agent-stable-smoke/<runId>`，完成后按模块归档到 CDS 验收中心。pass 只归档；conditional 或 fail 通过 `scripts/stable-smoke-notify.mjs` 定向发送 MAP 站内通知到配置用户。禁止发送 Slack，禁止发送全局通知。

报告必须列出 CDS 环境与正式环境各自结果、caseId、产物断言、requestId、证据、清理和恢复动作。任何必跑模块未执行时最多为 conditional。
