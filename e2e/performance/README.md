# MAP 隔离性能回归

从仓库根目录运行。复用 `e2e` 的 Playwright、锁文件和真实登录表单，API 使用指定 Git 提交的 Release 产物，Web 使用该提交的生产构建。无需 MAP/CDS/模型服务凭据，不向远端压测。

准备：Linux 本地 Docker、.NET 8 SDK、Node 20+、pnpm；安装现有依赖与浏览器：

```bash
pnpm -C e2e install --frozen-lockfile
pnpm -C e2e exec playwright install --with-deps chromium
node --test e2e/performance/*.test.mjs
dotnet run --project e2e/performance/probe-tests -c Release
```

环境有预装 Chromium 时可设置 `PERF_CHROMIUM_PATH`；SDK 不在 PATH 时设置 `DOTNET_BIN` 为其可执行文件绝对路径。测试固定访问本地 Unix Docker socket，忽略远程 Docker 上下文。

## 执行与比较

先选择同一个不可变基准提交，三次运行各自创建并销毁全新数据库：

```bash
BASE=$(git rev-parse origin/main)
for attempt in 1 2 3; do
  node e2e/performance/run.mjs --ref "$BASE" --profile normal --out "work/performance/base-$attempt"
done
node e2e/performance/calibrate.mjs work/performance/base-{1,2,3}/result.json --out work/performance/baseline.json
node e2e/performance/run.mjs --ref HEAD --profile all --baseline work/performance/baseline.json --out work/performance/candidate
```

`normal` 为 2 个并发用户、每用户每秒开始一次事务、持续 20 秒。`all` 再执行 2/4/8/16/32/64/128 并发用户，各 15 秒无思考间隔；最后以正常负载持续 120 秒。压力阶段事务错误率超过 10% 时停止继续加压，仍执行持续运行阶段。间隔只控制负载节奏；所有登录、导航、正文加载、保存和写后校验都等待实际响应或可见内容，无固定 UI 等待。

正常阶段每场景至少 30 个样本。预热不进入统计。各阶段独立报告 p50/p95/p99、错误率、成功吞吐和各容器进程树 CPU/内存消耗。CPU 从 Linux `/proc` 的进程累计时钟增量计算，100% 表示一个核；内存是各进程 RSS 之和，包含共享页重复计算，不等于 PSS。原始请求留在 `requests.ndjson`，阶段资源样本范围在 `result.json`。吞吐以实际阶段墙钟时间为分母，包括尾部完成时间。请求错误保留状态与异常，成功延迟分位数不混入超时；同时必须查看错误率。

负例执行会返回 1；必须再验证失败确实来自应用性能退化：

```bash
node e2e/performance/run.mjs --ref "$BASE" --profile normal --inject-ms 350 --baseline work/performance/baseline.json --out work/performance/injected
node e2e/performance/prove.mjs work/performance/injected/result.json
```

## 场景与数据

浏览器每轮从真实登录表单开始，等待首页接口和知识库入口，点击进入知识库、选择固定文档、编辑正文、保存，再刷新验证可见内容及服务端持久化。每步截图，失败保留截图及 DOM；接口成功不能替代浏览器路径成功。

负载事务依次覆盖首页「继续上次」、知识库带预览列表（与前端一致取最多 500 项）、文档正文、创建文档、保存 8 KiB Markdown、写后读取、版本历史、删除本次临时文档。6 个知识库各 20 篇固定文档；使用一个本地播种管理员，所有 VU 各创建独立文档，避免互相覆盖。该账号代表有写权限的知识工作者，不覆盖多租户权限分布。首页完整渲染由浏览器验收，接口压力仅覆盖其核心聚合请求；不能把它解释成全首页所有后台请求的并发容量。

写入走真实正文存储、版本快照、摘要索引与双链更新，不依赖模型生成。临时文档删除不会抹去审计/活动历史，因此持续运行仍能暴露后台台账增长影响。

默认每账号 600 请求/分钟、100 并发会让共享账号的 VU 和数据准备争抢同一桶。执行器记录原配置，并通过既有管理 API 仅把本次临时实例调为 100000 请求/分钟、1024 并发；实际 Redis 限流链仍执行，未使用豁免身份。此配置纳入比较契约。默认准入限流与应用资源饱和必须分别解释，不能把这里的测得容量套到默认单账号配额。

## 归因、阈值与容量含义

测试专用 HostingStartup 探针由执行器注入，不改动产品代码，也不进入生产构建。`Server-Timing` 的 `server` 是从测试中间件到响应头开始发送，`external_http` 是期间 HttpClient 依赖调用的时间并集，`app` 为两者之差，包含数据库、Redis、排队和应用处理。客户端往返还包含 Nginx、传输和响应体读取。外部 HTTP 流式正文在响应头后的读取不算入该探针的依赖时间；本套流程均为 JSON、本地文本且不调用此类服务。

数据库和 Redis 属于本次被测系统；不能把 `app` 当作纯 CPU 时间。模型/订阅/云存储在本隔离网络不可达，此路径外部 HTTP 为零。另有真实 Kestrel/HttpClient 归因自测：两个并行慢依赖按并集统计，350ms 应用注入归到应用耗时。

阈值按同提交三次干净环境的正常阶段实测校准：p95 上限取「三次最大值 × 1.3」和「最大值 + 3 × 极差」的较大者；零错误基线错误率上限为 `3 / 总样本数`（近似 95% 零事件上界）；成功吞吐下限为三次最小值的 70%。正常及持续阶段都检查客户端和应用 p95、错误率、吞吐、覆盖率；并发增长阶段用于探边界，不套正常负载门禁。

容量边界记录首个「任一场景错误率 >1% 或 p95 超过正常负载两倍」的并发档位。它是给定数据、账号、CPU/内存配额和无思考时间下的相对退化起点，不是生产可承诺用户数。若最高档位仍未退化，明确记为未触及边界。120 秒持续测试是短期稳定性基线，不足以证明小时级内存泄漏不存在。

契约包含负载/数据规模、探针与执行代码、SDK、Node 主版本、CPU 型号/架构、镜像 digest 和容器配额。任一变化拒绝比较，须同机重新校准。提交号不属于契约，可比较不同提交。构建只复用按不可变提交、SDK 和架构隔离的本地缓存；每次运行均重建容器与数据。

## 隔离与 CI

执行器无目标 URL 参数，输出限于仓库 `work/`，拒绝覆盖已有结果。每轮创建独立 `--internal` Docker 网络，Mongo、Redis、API 不发布端口；仅固定路由的静态 Web 代理额外加入本轮入口网络，并发布到随机的 `127.0.0.1` 端口（Docker 29 不对纯内部网络发布端口）。容器显式清空代理，浏览器拒绝非本地请求。API 限 1 CPU/1 GiB，Mongo 1 CPU/768 MiB，Redis 与 Web 各 0.5 CPU/256 MiB，禁用额外 swap。镜像按 digest 固定。API 的测试运行镜像以 Mongo 官方 Ubuntu/OpenSSL 基础环境补装固定版本 ICU，以只读挂载的同一 .NET SDK 启动，替换入口，不启动该容器的 mongod；API 进程沿用执行用户 UID/GID。成功和异常退出都会清理本次容器、匿名卷和网络，不接触其他实例。进程被硬终止或宿主崩溃时仍需按本次 `map-perf` 标签清理遗留资源。

执行器核对容器内实际 cgroup 的 CPU 和内存限制，并记录进比较契约。上段是请求的配额；无 cgroup 委派的 rootless Docker 可能不执行这些限制，此时明确标记 `requestedLimitsEnforced=false`，不能把请求配额写成实际容量条件。资源始终按各容器 PID 的独立进程树采样，不采信共享 cgroup 的 `docker stats`。本次云环境若使用共享 4 CPU/16 GiB，容量报告只适用于这组实测条件；支持 cgroup 的 CI runner 则使用实际容器配额重新校准，二者不可混比。

现有 **Preview Acceptance** 增加隔离性能 job：相关 PR 自动校准基准 SHA 并比较候选 SHA，手动执行可提供 `perf_ref` / `perf_base_ref` / `perf_profile`。默认正常负载门禁，`all` 执行全部三类测试；同一 runner 先测基准再测候选，最后必须证明受控退化被拒绝。该 job 不使用环境密钥、不部署、不购买资源；报告作为 Actions artifact 保留 14 天。没有 PR 时可手动 dispatch；本任务不自动创建 PR。

如被硬终止，只清理该结果 `environmentId` 对应标签的资源，不使用全局 prune。查看 `result.json` 的 `failure`、`comparison` 和截图确定是基础设施、功能失败还是性能回归；基础设施失败不能算作成功识别退化。
