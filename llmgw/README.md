# LLM Gateway

`llmgw/` 是 LLM Gateway 的单一产品根目录。控制台 API、Web 控制台和 serving host 在这里共同演进；仓库根 Compose、CDS 与 CI 只引用本目录，不保留旧目录兼容副本。

## 目录

```text
llmgw/
├── console-api/  控制台、租户、密钥、治理和观测 API，端口 8090
├── web/          React Web 控制台，容器端口 80
├── serving/      四协议 serving host，端口 8091
├── deploy/       部署边界与运行契约说明
└── docs/         Gateway 文档入口
```

`serving/` 继续通过显式 ProjectReference 复用 `prd-api` 的 Core 与 Infrastructure。该依赖不改变 `ILlmGateway`、Mongo 集合、配置键或 HTTP 协议语义。

## 本地校验

```bash
dotnet build llmgw/console-api/prd-llmgw.csproj --no-restore
dotnet build llmgw/serving/PrdAgent.LlmGateway.csproj --no-restore
pnpm --dir llmgw/web build
```

完整后端与 Gateway 测试仍由 `prd-api/PrdAgent.sln` 统一执行；该 solution 使用相对路径引用 `llmgw/serving`。

## 不变量

- 外部 URL 仍为 `/llmgw/*` 与 `/gw/v1/*`，不因源码目录改变。
- Mongo 数据库、集合、索引和 `TenantId` 语义不变。
- 镜像、容器与环境变量名称不变。
- tenant 只从服务端会话或 service key 解析。
- 不保留旧目录、符号链接或双写构建入口。

## 公开入口

- 正式 MAP 继续兼容 `/llmgw/*`，这是现有二级目录入口。
- 独立域名可把根路径完整反代到宿主机 `8081`，由 `llmgw-web` 同源承接 Console API 与四协议。
- CDS 验收必须使用 `llmgw-web` 命名服务子域，不能用共享预览根路径冒充独立 Gateway。

域名、证书、Nginx 验收和测试数据口径见 `deploy/README.md`。

### 请求预警处置

在「请求记录」展开平台请求预警，可查看固定限流窗口的恢复时间。后台调用方小时限流支持在原预警申请额外次数，由组织管理员审批，本小时结束时自动失效。临时次数只适用于该租户、用途和请求类型的这一小时窗口，其余限额照常执行。

外部 OpenAI 兼容调用方可以在请求中提供 `X-Gateway-Retry-Run-Id`，标识能在原业务系统恢复的批次。只有已经实现补跑的业务程序才发送这个头。网关收到小时限流拒绝时记录关联，控制台可为该批次安排窗口恢复后的补跑。旧预警或缺少批次标识的请求显示原业务入口处置提示。

业务程序使用原服务密钥和 `X-Gateway-App-Caller`，通过 `GET /gw/v1/consumption-retries` 读取到期可执行的动作。执行前向同一路径提交 `id`、持久化的 32 位十六进制 `claimId` 和 `outcome: "claim"`。同一动作只有一个领取者，网络重试应沿用原领取编号。业务程序从自身的批次状态补跑未完成项，随后用相同编号提交 `outcome: "completed"` 和 `completedCount`，或提交 `outcome: "failed"`。原告警显示领取及回执状态。执行器重启后从自己的持久化进度恢复，网关保留原领取归属。

### 上游代理

在控制台「上游」展开「全局上游代理」，可以为当前组织设置 HTTP、HTTPS 或 SOCKS5 代理。新增和编辑上游时，可选择跟随全局、使用独立代理或强制直连。列表上的标签会标明生效方式；代理地址必须能从网关服务器访问，目标域名由代理解析，账号密码分别填写，密码加密保存且不回显。

保存后可用「连续测试网络」建立三次连接，查看本次连通率、平均和最快／最慢耗时。该测试不发起模型推理；收到 401、403、404 等响应会说明网络已连通但服务尚未验证。要核对模型列表和密钥，请继续使用供应方的「测试连接」；短时采样不能证明长期稳定。

发布前协议回归、能力适用矩阵与真实供应商验证入口见 [协议兼容回归](docs/protocol-regression.md)。
