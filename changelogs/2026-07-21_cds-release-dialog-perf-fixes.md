| refactor | cds | 发布弹窗重构为分阶段向导(选站点 → 发布前检查 → 发布):发布开始后前序配置/预检收起成一行摘要、实时发布状态占满弹窗,不再被长滚动挤到最底部遮挡 |
| fix | cds | 发布前检查里的发布脚本收进「查看脚本」折叠框 + 自身横向滚动,修复整段 shell 平铺撑破弹窗、底部横向滚动条的问题 |
| refactor | cds | 发布弹窗主操作固定到底部 sticky footer,按阶段只显示一颗主按钮(发布前检查 → 开始发布 → 打开上线地址),非专家也能看懂下一步 |
| fix | cds | CDS 系统设置的「用户管理 / 用户痕迹」tab 按运行时认证模式门控:auth-local 路由仅在 authMode=github 时挂载,basic/disabled 模式下无条件调用 /api/auth/users、/api/auth/activity 会直接 404,现按 /api/auth/public-status 探测的 mode 隐藏这两个 tab 并回退默认 tab |
| perf | cds | 修复接口持续排队(3.7s 攀升至 40s+)的两个高置信根因之一:部署卡死看门狗的 execSync(git diff) 幂等判断前置 + 按不可变 sha 对记忆化,stale 分支不再每 5 分钟重复同步阻塞事件循环 |
| perf | cds | 项目列表页轮询从裸 setInterval 改为自调度循环:等上一轮返回再排下一轮(天然 in-flight 去重)、页面隐藏暂停、回前台立即刷新;并消除每轮重复请求两次 /api/pending-imports;资源用量弹窗 5s 轮询同改 |
| test | cds | 新增回归测试:已告警分支跳过 diffRuntimePaths(锁定幂等前置的性能语义) |
| fix | cds | forwarder 代理响应剥掉 hop-by-hop 头(Connection/Keep-Alive/Transfer-Encoding 等):master SSE 的 Connection: close(防 nginx upstream 池复用死 socket,保留)不再透传到 HTTP/2 客户端连接,修复 /api/branches/stream 约 2.7 分钟 ERR_HTTP2_PROTOCOL_ERROR 断流 |
| perf | cds | http 请求日志治理:成功 GET 读请求(轮询/控制面/静态)按 1:10 采样落库(非 GET/错误/SSE/部署/容器操作全保留,在途请求实时面板不受影响);写链加 500 条有界背压,Mongo 慢时丢弃非错误记录而非无界积压 |
| perf | cds | mongo-split 存储层增量快照重构：save() 支持脏范围 hint，同 tick 全带 hint 时只克隆被点名的 kind/实体，不再对整个 state 做 structuredClone |
| perf | cds | mongo-split 持久化改按实体 id 缓存上次落库的 stableJson 字符串，diff 只 stringify 当前侧；删除 persistedCache 整份 state 的第二次 structuredClone，消灭每周期约 4 遍全量序列化 |
| perf | cds | 部署 run 事件 append/心跳、发布日志、服务部署日志等高频写路径带上实体级/global 脏 hint；部分写失败自动全量重同步兜底，flush/generation/启动恢复语义不变 |
| test | cds | server-integration 套件对沙箱环境免疫:套件级摘除 CDS_USERNAME/CDS_PASSWORD(结束后恢复),修复开发机/Agent 沙箱配置远端 CDS 凭据时 10 个用例因 basic auth 误开而 401 假红 |
| fix | cds | 站内信陈旧通知清理:通知面板打开时对引用的项目探活,项目已删除(404)的通知自动移除,不再让用户点「查看推荐方式」落到已失效项目的 404 页;项目元信息降级(fallback)期间不再新发携带死链的通知 |
| fix | cds | 分支失败归因补全:detectContainerFatalCause 新增 Flyway 迁移失败/exit 137/139/signal 9(代码侧)与 OOM(配置侧)模式,就绪探测日志取样窗口 80 行扩到 400 行;Spring/Flyway 应用崩溃不再被误标成「就绪探测超时」甩锅 CDS |
| test | cds | 新增 Flyway/exit-137/OOM 归因回归测试 |
| fix | cds | mongo-split 写失败恢复加固:在途写失败时排队中的 partial 就地升级为全量快照,杜绝 flush 谎报成功而失败变更缺失的窗口(Codex P1) |
