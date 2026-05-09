# CDS 控制面/数据面分离 + 蓝绿部署 — MECE 验收清单

> **版本**:v1.0 | **日期**:2026-05-08 | **状态**:实现前签收
>
> 本文档是 `doc/design.cds-control-data-split.md` 的契约。**实现必须使每条用例可被自动化验证或人工逐项打勾**。所有 .test.ts 骨架与本清单一一对应。

---

## 验收原则

1. **MECE**:8 个验收维度互斥穷尽(Mutually Exclusive, Collectively Exhaustive),没有任何场景两个维度都覆盖,也没有任何关键场景遗漏
2. **每条都可证伪**:用例必须能在自动化测试或线上 cds.miduo.org 复现并产出"通过/不通过"二元结果
3. **TDD 驱动**:本清单 = `.test.ts` 文件 = 实现的契约。先写测试,再让 sub-agent 实现到全绿
4. **双智能体监督**:本清单与 `.test.ts` 由主 session(PM/QA)写,实现由 sub-agent 写,两者隔离

---

## 维度 1:**正确性**(Correctness)— 功能确实做到了它声称做的事

| ID | 用例 | 验证方式 |
|---|---|---|
| C-1.1 | Forwarder 收到 `*.miduo.org` 流量,根据路由表能找到正确的 upstream 容器端口 | unit test:mock 路由表 + http.request 断言转发到指定端口 |
| C-1.2 | Forwarder 收到未注册的 host,返回 503 + cds-waiting 页面 | unit test:断言 status 503 + body 包含 waiting page 文案 |
| C-1.3 | 路由表 mongo 变更后,Forwarder 内存表毫秒级刷新(无需重启) | integration test:写 mongo → 100ms 内 hit 新路径 |
| C-1.4 | mongo 不可达时,Forwarder fallback 到本地 JSON 路由表继续工作 | integration test:断网 mongo + 路由仍 work |
| C-1.5 | Admin daemon 蓝绿切换后,新实例能正确接管所有 self-update 历史的查询 | end-to-end:切换后 GET /api/self-status 返回 lastSelfUpdate 完整 |
| C-1.6 | self-update 走蓝绿路径成功:nginx upstream 文件被改写、daemon 双实例存在过、最终单实例存活 | integration test:观察 .cds/active-color 切换 + ps 验证 daemon 数量 |
| C-1.7 | self-update 失败时(新 daemon healthz 不通过),supervisor 自动回滚,旧 daemon 仍处理流量 | fault-injection test:故意让新 daemon 健康检查失败,断言 active-color 不变 |
| C-1.8 | 网络拓扑面板返回的图(API)与实际 mongo 路由表 + nginx upstream + 容器列表完全一致 | integration test:断言 API 数据与实际状态字段全等 |

## 维度 2:**兼容性**(Backward Compatibility)— 不能砸死现有路径

| ID | 用例 | 验证方式 |
|---|---|---|
| C-2.1 | `CDS_ENABLE_BLUE_GREEN=0`(默认)时,self-update 走老的 process.exit + systemd 重启路径,行为与今天完全一致 | integration test:env 设 0 跑 self-update,观察 daemon PID 变化(老路径 PID 必变) |
| C-2.2 | `CDS_DISABLE_BLUE_GREEN=1` 紧急回退开关有效,即使其他配置开了蓝绿也回到老路径 | integration test:同 C-2.1 但优先级高 |
| C-2.3 | Forwarder 未启用时,daemon 仍能完整反代 *.miduo.org 流量(老链路保留) | integration test:不启 forwarder.service,流量仍通过 daemon |
| C-2.4 | 历史 selfUpdateHistory 流水的 mode 字段(restart / hot-reload / web-only / doc-only / noOp)继续被 UI 正确渲染 | unit test:旧数据格式与新 UI 渲染兼容 |
| C-2.5 | nginx 模板从单 upstream 升级到 active-upstream include,旧版本 nginx 配置仍能 reload 通过 | integration test:nginx -t 在升级前后均通过 |
| C-2.6 | 只升级了 admin daemon、没升级 forwarder.service 的混合版本场景下,行为仍正确(降级到 daemon 内置反代) | integration test:模拟 forwarder 不存在时的链路 |
| C-2.7 | 现有所有单元测试(/cds/tests/**)在改动后必须仍然通过 | run:`pnpm vitest run`,断言 0 fail |

## 维度 3:**性能**(Performance)— 时间与吞吐基线

| ID | 用例 | 验证方式 |
|---|---|---|
| C-3.1 | self-update 蓝绿模式:用户感知"切换"时间 ≤ 1 秒(从 SSE done 到 banner 消失) | benchmark:cds.miduo.org 实测 P95 ≤ 1000ms |
| C-3.2 | self-update 蓝绿模式:nginx reload 那一瞬间 *.miduo.org 流量阻塞时间 ≤ 200ms(buffered request) | load test:并发 100 req 期间触发 reload,断言无 5xx + 单请求最长 ≤ 200ms |
| C-3.3 | Forwarder P50 转发延迟 < 5ms,P99 < 30ms(本机) | benchmark:autocannon 1k req,断言分位数 |
| C-3.4 | Admin daemon 启动时间 ≤ 3 秒(从 systemd ExecStart 到 healthz 200) | benchmark:实测 cds.miduo.org daemonReadyAt - spawn time |
| C-3.5 | 路由表 1k 条规则下 Forwarder 内存占用 < 100MB | benchmark:压测 1k routes + 持续转发 1 分钟 |
| C-3.6 | mongo change stream 路由更新延迟 P99 < 500ms | integration test:写 mongo 时打时间戳,forwarder 命中新路由时打时间戳,差值 < 500ms |

## 维度 4:**安全**(Security)— 不能引入新攻击面

| ID | 用例 | 验证方式 |
|---|---|---|
| C-4.1 | `/api/_internal/promote` / `/_internal/standby` 接口拒绝非回环 IP 请求 | unit test:模拟外部 IP 调用,断言 403 |
| C-4.2 | Forwarder `/__forwarder/routes` 接口拒绝非回环 IP | unit test:同上 |
| C-4.3 | Supervisor 写 nginx upstream 文件时校验路径白名单(只允许 `nginx-active-upstream.conf`) | unit test:传入恶意路径(`../../etc/passwd`)断言拒绝 |
| C-4.4 | Forwarder 收到伪造 `Host` header 时按路由表已知规则匹配,无法路由的 host 直接 503,**不会**透传到任意 upstream | unit test:伪造未注册 host,断言 503 + 不发起 upstream 请求 |
| C-4.5 | nginx active-upstream.conf 写文件操作要 atomic rename(避免 reload 读到半截) | unit test:模拟写入中断,断言文件状态一致 |
| C-4.6 | Bridge / 业务 webhook 调用必须经过 admin active 实例,不会落到 standby(防止 standby 副作用) | integration test:standby 实例直接调用 POST 业务接口 → 拒绝并提示用 active |

## 维度 5:**运维**(Operability)— 出问题时能自救

| ID | 用例 | 验证方式 |
|---|---|---|
| C-5.1 | Forwarder 进程崩溃后 systemd 在 ≤ 3 秒内拉起;期间 *.miduo.org 流量返回 cds-waiting 页面而非裸 502 | fault-injection:kill -9 forwarder,断言恢复时间 + 期间响应 |
| C-5.2 | Admin daemon 蓝绿切换失败后,流水里有清晰的 stage 字段(spawn / health-check / nginx-reload / promote / shutdown-old)定位失败位置 | integration test:每个 stage 故意失败一次,断言流水字段精确 |
| C-5.3 | 双 daemon 残留(supervisor 崩了)时,startup reconcile 能识别并清理 | startup test:模拟两个 daemon 都活着启动,断言只一个保留 |
| C-5.4 | nginx -t 失败时不执行 reload,旧配置仍生效,UI 提示"配置语法错误"具体行号 | fault-injection:写错 active-upstream.conf,断言 UI 错误信息 |
| C-5.5 | active-color 文件不可读时(权限/IO 错误),daemon 启动有明确 fail-fast 信息(systemctl status 一目了然) | startup test:chmod 000 active-color,断言 exit code + 日志 |
| C-5.6 | 蓝绿切换流水永久保留,UI 历史区可看每次切换的:谁触发、起止时间、from/to color、to-sha、是否成功 | integration test:UI 渲染验证 |

## 维度 6:**用户体验**(UX)— 屏幕上看到的体感

| ID | 用例 | 验证方式 |
|---|---|---|
| C-6.1 | self-update 走蓝绿模式时,GlobalUpdateBadge 显示"切换中"≤ 1 秒,**不**触发"CDS 重启中"全屏 overlay | manual + screenshot diff |
| C-6.2 | Dashboard 顶部常驻 build SHA chip,显示当前 active 颜色 + commit hash | manual + screenshot diff |
| C-6.3 | git HEAD 与 active daemon 的 buildSha 不一致时,顶部 chip 变红 + tooltip 说明"漂移" | unit test:模拟不一致状态,断言 UI 渲染 |
| C-6.4 | 维护页历史区显示新 mode chip:`蓝绿`(青色)、`完整重启`(琥珀色,fallback);tooltip 解释 | manual + screenshot diff |
| C-6.5 | 网络拓扑面板初次进入 ≤ 1 秒渲染完整图;hover 节点高亮关联边;点击节点弹详情 | manual UAT |
| C-6.6 | self-update 弹窗里实时显示 supervisor 编排阶段(SSE 推送):"等绿就绪 (2s) → 切流 → 退役蓝" | manual + log review |

## 维度 7:**可观测性**(Observability)— 黑盒外部能看到状态

| ID | 用例 | 验证方式 |
|---|---|---|
| C-7.1 | `GET /api/self-status` 返回完整身份字段:`{ gitHead, builtSha, activeDaemonSha, activeColor, activePort, forwarderHealthy, forwarderRoutesCount }` | unit test:断言 payload 形状 |
| C-7.2 | Forwarder `/__forwarder/stats` 返回:总请求数、各 host 命中数、503 数、最近 60s rps、最大延迟 | unit test:断言 schema |
| C-7.3 | 蓝绿切换的 supervisor 编排步骤通过 SSE 推送给前端,event 格式与现有 self-update 一致 | integration test:SSE 字符串解析 |
| C-7.4 | systemd journal 里 cds-master / cds-forwarder 各自有清晰前缀,运维 `journalctl -u cds-master -f` 能看清 | manual log review |
| C-7.5 | 网络拓扑 API 数据来源透明:每个节点带 `dataSource` 字段(mongo / docker / nginx-conf / process-self),便于排查"为什么这条不对" | unit test:断言字段存在 |

## 维度 8:**回滚**(Rollback)— 出问题能快速恢复

| ID | 用例 | 验证方式 |
|---|---|---|
| C-8.1 | `CDS_DISABLE_BLUE_GREEN=1` 一行环境变量回到老路径,无需改代码 | integration test:验证开关效果 |
| C-8.2 | self-update 蓝绿失败 → supervisor 自动回滚 nginx upstream + 杀掉新 daemon + 旧 daemon 继续处理流量 | fault-injection:故意让 promote 失败 |
| C-8.3 | 整个 forwarder.service 出问题 → 关停服务 + nginx fallback 配置改回直接 → admin daemon 内置反代兜底(回到今天的链路) | manual playbook test |
| C-8.4 | mongo 路由表损坏 → JSON 快照可用 → forwarder 仍能从快照启动 | fault-injection:删 mongo collection,断言启动 |
| C-8.5 | 蓝绿切换 ≥ 3 次连续失败时,supervisor 自动禁用蓝绿,改走老路径并告警 | integration test:连续失败注入 |

---

## 验收执行流程(操作手册)

### 自动化测试(每次 PR 必跑)

```
cd cds && pnpm vitest run tests/forwarder/ tests/blue-green/ tests/topology/
```

绿色全过 → 进入下一阶段。任何 fail 立即修。

### 端到端测试(merge 前必跑)

1. 部署到 cds.miduo.org(走 force-sync 触发)
2. 按本清单维度 6 / 维度 8 的 manual 用例逐项打勾
3. 记录每条 P50/P99 实测数据(性能维度 C-3.x)
4. UAT 报告写入 `doc/report.cds-blue-green-uat.md`

### 失败时的处理

- **维度 1-5 任一失败**:阻塞合并,sub-agent 必须修
- **维度 6**:阻塞合并(用户体验是核心目标)
- **维度 7-8**:阻塞合并(可观测性 + 回滚是上线先决)

---

## 与 .test.ts 的对应关系

| .test.ts 文件 | 覆盖维度 |
|---|---|
| `cds/tests/forwarder/route-resolver.test.ts` | C-1.1, C-1.2, C-4.4 |
| `cds/tests/forwarder/route-watcher.test.ts` | C-1.3, C-1.4, C-3.6, C-8.4 |
| `cds/tests/forwarder/proxy-handler.test.ts` | C-3.3, C-4.4, C-5.1 |
| `cds/tests/forwarder/diagnostic-routes.test.ts` | C-4.2, C-7.2 |
| `cds/tests/blue-green/supervisor.test.ts` | C-1.6, C-1.7, C-5.2, C-8.2 |
| `cds/tests/blue-green/standby-mode.test.ts` | C-1.5, C-4.1, C-4.6 |
| `cds/tests/blue-green/graceful-shutdown.test.ts` | C-3.4, C-5.3 |
| `cds/tests/blue-green/nginx-upstream-writer.test.ts` | C-4.3, C-4.5, C-5.4 |
| `cds/tests/topology/network-topology-api.test.ts` | C-1.8, C-7.1, C-7.5 |
| `cds/tests/topology/build-sha-chip.test.ts` | C-6.2, C-6.3 |
| `cds/tests/integration/self-update-blue-green.test.ts` | C-1.6, C-3.1, C-3.2, C-6.1, C-6.6 |
| `cds/tests/integration/rollback-paths.test.ts` | C-2.1, C-2.2, C-8.1, C-8.3, C-8.5 |

每个 test 文件的所有 `it()` 都需在描述中标注它对应的 `C-X.Y` ID,这样反向追溯极其容易。
