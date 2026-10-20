# CDS 自更新极速版（预构建产物） · 债务台账

> **版本**：v1.2 | **日期**：2026-07-27 | **状态**：已接线（灰度开关默认开，待生产观察窗口）

**一句话**：自更新从本机现编改为拉预构建产物再原子替换，本文记已验证部分与尚未验证的开放债务。
**谁该读**：维护自更新链路的人。
**读完能做什么**：判断自更新当前的可靠性边界。

---

## 总览

把 CDS 自更新的「本机现编」（tsc 52s + vite 1.6min ≈ 3min）改为「拉 CI 预构建产物 + 原子替换 + 重启」（几十秒）。
与项目极速版同理：编译卸到 GitHub Actions，自更新只「拉 + 换 + 起」。

用户诉求（2026-06-27）：「既然代码被 CI 编译了，自更新就该拉现成的、不要本机再编一遍。」

## 已完成（已验证）

| 层 | 文件 | 状态 |
|---|---|---|
| CI 预构建 | `.github/workflows/cds-prebuilt.yml` + `cds/Dockerfile.dist` | **完成 + CI run 已 success**。push 改 `cds/**` → 编译（tsc 门 + esbuild 后端 + vite 前端）→ ghcr `cds-dist:sha-<40hex>` |
| 决策纯函数 | `cds/src/services/cds-prebuilt.ts` | **完成 + 10 单测**。`computeCdsPrebuiltImageRef`（与 CI 同公式）/ `parseCdsPrebuiltManifest` / `shouldTryCdsPrebuilt`（灰度开关） |
| 运行层拉取 | `cds/src/services/cds-prebuilt-runtime.ts` | **完成 + 8 单测**。`fetchCdsPrebuilt`：docker pull/create/cp 解出 `/dist` `/web-dist` 到 staging + 校验 manifest；失败 `ok:false` 供回退 |
| orchestrator 接线 | `cds/src/routes/branches.ts` 的 `tryApplyCdsPrebuiltForSelfUpdate` | **已接线**。`!forceMode` 时先判 `shouldTryCdsPrebuilt` → `fetchCdsPrebuilt` → `validateWebDistCandidate` 校验入口 HTML/JS/CSS 真实存在 → `replaceDirectoriesAtomically` 原子替换 `dist` 与 `web/dist` → 写 `.build-sha` 标记；命中后额外跑一次 `nginx-render` 用预构建 dist 重渲染模板。命中失败或 `applied=false` 时**原地 fall through 到本机现编路径**（`if (!prebuiltApplied) { ... }`），行为零回归 |

**注意：与本文档 v1.0 描述不同的地方（2026-07-20 核对代码后更正）**：灰度开关 `CDS_SELFUPDATE_PREBUILT` 的默认值是**开**，不是"默认 off"——`selfUpdatePrebuiltEnabled()` 只在值命中 `0/false/off/no` 时才关闭，未设置该变量时视为启用。生产环境如需继续走本机现编，必须显式设置 `CDS_SELFUPDATE_PREBUILT=0`。

## 近期相关补丁（同一 self-update 路径，2026-07-20 落地）

以下三个改动都改的是 `tryApplyCdsPrebuiltForSelfUpdate` / self-update handler 同一条路径，记录于此避免散在 commit message 里：

- **原子切换保留上一代 web 资源**（`replaceDirectoriesAtomically` 新增 `previousPath` 参数）：切换 `web/dist` 时把旧产物移到 `web/dist.previous` 而不是直接删除，修复自更新后已打开的浏览器标签页请求到新 `index.html` 但旧懒加载 chunk 已被删除导致的黑屏（跨代不一致）。同时 `validateWebDistCandidate` 会真实解析候选 `index.html` 的 `src`/`href`，逐个校验入口资源存在且非空，不再只查 `index.html` 是否存在。
- **生产更新防护（乐观锁 + 精确 SHA 重启）**：共享控制面的**普通**非快进更新（版本回退 / 跳跃）要求显式 `intent`（`release`/`rollback`）+ `expectedFromSha` 乐观锁 + `reason` 审计原因；同 SHA 与快进更新保持旧客户端兼容路径。新增不拉代码、不切分支、仅按精确 SHA 重启当前工作区的接口和 `cdscli` 命令。另修复 `cdscli` 收到 self-update SSE `error` 事件后仍返回成功退出码的问题。**这条闸门只挡普通更新**——2026-07-30 起「强制更新」走独立解析（`resolveForceSyncTransition`）永不拒绝，`intent`/`reason` 缺省时记「未声明」而非拒绝，因为强制更新是用户控制 CDS 的最后手段，能被策略拒绝的强制不叫强制。两条路径分工：普通更新守严格闸门，强制更新是逃生阀。
- **渐进式 Agent 操作者身份**：新增 `agent-operation-context.ts` + `actor-resolver.ts`，采集调用方 Agent session，贯通请求 ID、操作 ID 与服务端事件日志，self-update / 精确 SHA 重启的结果会带上这三个标识供复盘关联；旧版不带身份信息的客户端调用保持兼容（身份字段全部可选）。

## 尚未验证（open）

- 生产环境尚未确认「命中 ghcr 镜像 → 拉取 → 原子替换 → 重启 → 起来」与「镜像缺失 → 自动回退本机现编」两条路径的真实灰度表现——本仓库沙箱无法端到端起 Docker 验证（CLAUDE §8.1）。
- `updateMode: 'prebuilt'` 已在 `types.ts` 声明并在 handler 中赋值，前端历史列表是否已按此值展示「极速版」标签待核对 UI 侧。

## 开放债务

| # | 状态 | 债务 | 影响 | 偿还方向 |
|---|------|------|------|----------|
| 1 | **偿还中(2026-07-27)** | 自更新重启与在途分支部署竞速：restart 模式不 drain 部署执行器，也不在启动后重排被杀的 run | 同一次 push 同时触发 webhook 分支部署与生产自更新时，分支部署被重启杀死——心跳过期后看门狗收敛为 failed（`cds.run.interrupted`，PR check 红灯），甚至重启窗口内到达的 webhook 派发整个丢失（无 run 记录）。2026-07-26~27 在 PR #1262 连续复现 3 次（dr_ff65dea4 / dr_40bacbb5 / 2b15f78 webhook 丢失），均需人工重触发。第 4 例（2026-07-27 宕机事故，见 [doc/debt.cds.state-json.md](./debt.cds.state-json.md) 事故档案）证实：中断派发的自动补发机制**已存在**但被 `CDS_DEPLOY_DISPATCH_RETRY_ENABLED` 门禁默认关闭——重启后事件明确打出「部署重试已关闭，跳过 1 个中断派发的自动补发」 | 自更新 restart 前对在途 deployment-run 二选一：等待到终态再重启（部署通常几分钟内完成），或把在途/重启窗口内到达的 run 持久化为 pending、启动后自动重新派发；与 `cds.run.interrupted` 看门狗联动（interrupted 且 retryable 的 run 启动后自动重试一次）。**已落地（事前避免）**：`deploy-drain.ts` + 自更新重启前钩子——重启前先等在途部署跑到终态（默认上限 5 分钟，`CDS_SELFUPDATE_DRAIN_TIMEOUT_MS` 可调，设 0 关闭；心跳过期的僵尸 run 不等；超时照常重启并把仍在途的 run 如实记进事件日志）。**刻意不走**「打开 `CDS_DEPLOY_DISPATCH_RETRY_ENABLED` 自动补发」——那道闸是 2026-06-24 为治重试风暴默认关掉的，补发属事后补偿，会把旧事故一并放回。2026-07-27 二次加固（Codex 第三十六轮 P1 x2）：① 在途判定改由**终态表取反**推导，补上初版漏掉的 `preparing` / `verifying`——同日第 7 次复现（`dr_16a91d5d50ba73d0db7e3507`）正是死在 `prepare`，初版排空对它视而不见；② 排空**一开始就关闭部署入口**（`/deploy`、`/deploy/:profileId`、`/force-rebuild/:profileId` 返回 503 + `Retry-After: 60`），消除「最后一次轮询之后、进程退出之前」的真空。闸门自带过期时间（排空超时 + 5 分钟）fail-open，重启万一没发生也会自动开，不会把部署永久锁死。剩余边界：重启窗口内**新到达**的 webhook 派发不再静默丢失，但会以「部署派发失败」红灯呈现（消息说明 CDS 正在自更新、可重试），仍需一次重触发；要做到零人工，得给派发加持久化待办队列，那是另一件事 |
| 2 | open(2026-09-03) | 自更新的 restart 步骤当日四次（86425ccf 两次、381e37e9 两次）未真正重启进程：`self update` 报 `restarted: true`、事件走到 `drain done`，但 `/api/self-status` 的 pidStartedAt 不变、接口仍返回旧代码；`self restart` 能正常重启 | 后端改动自更新后看似成功实则没上线，验收会对着旧进程取证（本次靠对比接口字段发现）；零停机前端路径不受影响 | 排查 drain 之后的重启分支为何未触发（systemd restart 未下发或被排空闸门吞掉），自更新完成后应比对 pidStartedAt 与更新时间并在不一致时报错，而不是只报 restarted:true |

## 相关

- `cds/src/services/cds-prebuilt.ts` / `cds-prebuilt-runtime.ts` —— 决策 + 拉取（已测）
- `.github/workflows/cds-prebuilt.yml` / `cds/Dockerfile.dist` —— CI 产物（已绿）
- [doc/debt.cds.ci-prebuilt.md](./debt.cds.ci-prebuilt.md) —— 项目分支极速版（同族：编译卸到 CI）
- `cds/src/routes/branches.ts` 的 `tryApplyCdsPrebuiltForSelfUpdate` / `replaceDirectoriesAtomically` / `validateWebDistCandidate` —— 已接线的 self-update 快路径
- `cds/src/services/self-update-checkout.ts` / `agent-operation-context.ts` / `actor-resolver.ts` —— 生产更新防护与操作者身份采集

## 2026-10-16 排空等待与正常关闭待办保留：验收边界

| 状态 | 边界 | 影响与下一步 |
|------|------|------------|
| 待验证 | 排空与运行收割改用同一本节点、项目分支服务、原操作代次及原阶段截止资格；不延长阶段或排空预算，不刷新假心跳，不为发布运行套用部署豁免 | 已有私有受控诊断证明旧行为遗漏合法等待；本轮永久回归、全量校验和真实更新验收尚未执行，不能据此认定现场全部队列根因或环境已恢复 |
| 待验证 | 正常关闭仅保留原协调器中未领取、当前仍排队、密封输入完整、原目标范围与受理代次一致、没有更新覆盖且原意图保存已正向确认的待办；旧进程不能再领取，重启后仍须原恢复与可靠领取 | 自更新仅在原有界全局保存成功且返回有效子进程PID时启用，不把异步启动失败当成功；信号关闭仅用已有保存回执，不新增等待。PID不代表后续脚本或新进程就绪，保留事件不是恢复或交接完成；全局保存失败仍须如实报告 |
| 已知窄覆盖 | 启动恢复的排队项只有原可靠保存实际成功且当前仍为同一排队密封意图时才取得正向回执；恢复数组、异步保存尚未确认或写入项缺席均不算成功；已领取、执行中、续接预约、损坏或明文输入及保存失败者仍走原中断策略 | 恢复保存未确认时发生的再次关闭仍可能中断原待办，不能宣称所有连续重启零丢失；不延长关闭预算、不重写持久队列或密钥协议、不重放执行态。真实连续重启与保存故障路径尚待验收 |
| 待验证（2026-10-20） | 最终中断状态或意图删除未在原一秒退出期限内确认保存时取消重启；等待脚本只有收到本次独立管道许可才可启动，失败恢复原分支、完整提交与后端/两代前端真实字节 | 旧实现已在真实退出回调复现持久队列复活；本轮改动的受控回归、准确提交的正常更新与公网业务仍待验收。PID不代表新进程就绪，不承诺存储故障下任意外部强制退出仍不丢失；原首轮332行与664行、前13文件/1100行记录保留；用户本轮明确批准必要修复上限13文件/1200行，不重置历史基线 |
| 待验证（PR1715-R4325795619） | 中断事件和原保留资格判断后清除运行、待办、已领取与续接许可，取消重启继续服务时仅恢复原合法待办；代次及生命周期监听不重置 | 原旧运行残留断言已改为撤销旧许可与迟到完成不得伤害新代次，首次语义失败保留；准确提交的真实保存故障、恢复部署和公网验收仍待完成 |
| 待验证（PR1715-R4326168681） | 旧源码、产物和两端安装依赖必须同代恢复，备份安装树时保留 pnpm 符号链与安装标记；无旧依赖树则撤掉更新产生的新树 | 原真实文件用例新增两端依赖字节并取得旧生产语义失败；真实安装符号树、故障回滚、准确提交与公网验收仍待完成，不用旧 CI 代签 |

---

## 已结清（供回溯）

下列条目台账里已自己标记为解决/交付，移到文末只为让上文只剩未还的账；内容原样保留。

## 2026-10-20 四入口维护准入必要依赖（候选，待验证）

预检会安装依赖和写入校验标记，不是只读观察。独立依赖在准确 R（2f4d3426）上统一普通更新、强制同步、精确重启与预检的同实例占用；真实 marker 写失败、首次异步读取、响应结束或客户端断开都不能让兄弟写者进入。安装和类型校验若首支抛错，要等本轮已启动兄弟收尾再保留原异常，不重试、不改原并行度或预算。

主轨已在旧生产取得 14 项真实 HTTP 消费者语义 RED，夹具更正后的原件为 maintenance-admission-timer-fixture-old-red.log（SHA256 62443d665c6aa8a4c44db917b17f70201d04c7f736d4fd7548deb6d87139dae0）；首次定时回调夹具错误及其首日志仍保留。当前候选尚未运行 GREEN、类型或默认全量，不能称已修复或事务完整。

重启占用只沿 R 原调度、退出及存活回收窗口转交；定时回调观察不等于实钟等待或真实 daemon 退出验收，也不证明跨进程安装已隔离。执行器若仍不能确认清理完成，不能靠释放占用声明未知写者已停止；真实 PNPM、符号链、取消与回滚需在原叶准确合流版本另验。

本依赖不带原叶的终态保存、排队恢复、许可或依赖检查点；合叶时必须保留其取消和恢复完成条件，再统一释放同一 owner，不保留两套互斥。原叶首 332/664、旧 13/1100/1087/1167 与当前 13/1200 历史不重置；依赖独立计数、独立验收，不能用新 base 或 Mock 结果代签原叶真实安装与恢复。

2026-10-20 非作者复核发现同根第三批遗漏：强制同步热路径的并行后端构建仍可在首败后让迟返写者脱管。首版4/428的20项定向通过和类型通过只证明其已测范围，不结清此缺口。新增反例在原首版生产取得14原例通过、新例1项语义失败（日志SHA256 0e04be891ef5de690e24eae1efbb4fc66cbd060757dc19389161ec2269f21a5b），原构建参数、迟返写入与错误控制均成立；历史证据不覆盖。

候选对该第三批也仅等待同批原任务收尾后保留原异常；不重发构建、不改变原并行度、参数或预算。新338行测试全部保留；新候选尚待准确版本定向、类型、默认全量和非作者复核，原生退出、真实依赖恢复边界仍未由本 Mock 用例结清。

## 2026-10-21 取消重启后的错误收尾边界

最终状态保存失败后，必须先确认重启许可子进程已经退出，再恢复原来已可靠受理、尚未领取且身份完整的待办。版本回滚失败仍须明确报失败，但不能因此跳过合法待办的恢复；这不扩大恢复资格，也不重放执行中的旧任务。候选回归与准确版本验收分开记录，不能把排队恢复理解成源码或入口已恢复。

维护占用仍有独立开放缺口：复制阶段需要真实可取消的有界写者，并把持有者来源、阶段与健康状态接到实际观察入口。真实写者或取消尚未确认结束时不得按过期时间直接放行；此必要依赖与本次错误收尾分别审查，未结清前不能宣告维护事务完整或合并。

