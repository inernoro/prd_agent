# debt.report-agent.daily

| 字段 | 内容 |
|---|---|
| 模块 | 日报技能（`daily-report-summary` + `reference/publish.py`） |
| 状态 | open（功能已可用，2026-05-31；以下为已知边界与后续优化） |
| 关联 | `.claude/skills/daily-report-summary/`、`create-visual-test-to-kb`、文档空间「日报知识库」 |
| 提出 | 用户 2026-05-31：日报技能 + 视觉验收联动，提示词精简、逻辑沉淀进技能 |

---

## 已知边界

### 1. committer date 在 fast-forward / rebase 合并下的口径漂移

本仓库 PR 全部走 **merge commit**，merge 的 committer date 即「落地主干」时间，按 `--first-parent <main>` + `%cd` 日期文本过滤当天提交，口径准确。

但若仓库改用 **fast-forward / rebase 合并**：被合并的提交保留更早的 committer date，可能让「当天 ff 落地」的提交按更早日期归档——表现为当天显示零活动而实际已发版，且与 merge 穿透统计不一致。

**后续修法**：遇到 ff/rebase 流程，改用 GitHub PR 元数据的落地 SHA 日期判定归属（参照 `weekly-update-summary` 纪律 3），不要只信 commit 的 committer date。

### 2. 视觉取证依赖预览环境 + 浏览器登录凭据

Phase 4.5 取证走 `create-visual-test-to-kb` 的 Playwright harness，依赖：预览环境就绪 + `MAP_AI_USER` / `MAP_ACCEPT_PASS` 浏览器登录凭据。无凭据 / 环境未就绪时跳过取证，报告显式注明「本期无截图」，不伪造证据。

**后续修法**：把日报取证凭据纳入 CDS 远端环境注入清单，让取证默认可用。

**2026-07-05 新增边界（沙箱出口代理与 Chromium 现代 TLS ClientHello 不兼容）**：本次日报执行环境的出口代理是 TLS 终止型 MITM 代理（`/root/.ccr/README.md`）。`curl` 直连该代理（CONNECT 隧道 + 标准 512 字节 ClientHello）握手成功、拿到 200；但 Playwright 打包的 Chromium（本例 HeadlessChrome/141）默认发送的 ClientHello 携带 **ECH GREASE 扩展（0xfe0d）+ 混合后量子 key_share（0x33，约 1263 字节，X25519+ML-KEM/Kyber768）**，导致 ClientHello 记录膨胀到约 1761 字节；代理在收到该 ClientHello 后立即 RST（`net::ERR_CONNECTION_RESET`，netlog 显示 `net_error:-101 os_error:104`，CONNECT 隧道本身已 200 建立，问题在 TLS 层）。已尝试 `--disable-features=EncryptedClientHello,ECHGrease,EncryptedClientHelloGrease,UseDnsHttpsSvcbAlpn,PostQuantumKyber,UseMLKEM,X25519Kyber768,MlKemKyberHybrid` 及 `--ssl-version-max=tls1.2` 均未能阻止该扩展出现（该 Chromium 版本可能已把 ECH GREASE 默认开启且未受这些 feature 名控制，或版本过新导致 flag 名已变化）。`example.com` 等任意域名同样复现，确认与目标站点/登录凭据无关，是本沙箱「代理 + 该 Chromium 版本」组合的环境限制。

**后续修法候选**：(a) 排查代理侧是否可放行/透传大体积 ClientHello 或原生支持 ECH 而非直接 RST；(b) 换用非 Playwright-bundled、版本更旧的 Chromium/Firefox 可执行文件（`executablePath` 指向支持关闭该行为的版本）；(c) 请环境维护者确认该沙箱镜像的 Playwright Chromium 版本与代理的兼容性组合。三条均超出日报技能自身范围，暂记录，供下次执行者跳过反复重新诊断。

### 3. 同日重复发布产生多条同名条目

`publish.py` 按库 find-or-create，但条目不做同日去重（`metadata.dailyDate` 已落，未据此拦截）。同一天重复跑会生成多条标题相同的条目。

**后续修法**：发布前按 `metadata.dailyDate` 查重，命中则更新已有条目而非新建（幂等）。

## 后续优化（非阻塞）

- 「按来源 / 标签订阅」与已读状态，向「个人早报」演进。
- 自动化定时：用户 2026-05-31 暂不做 cron；如需，走 Claude Code on the web 的定时触发（在环境侧配置，不入仓库），技能逻辑不变。
