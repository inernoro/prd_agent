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

### 上游代理

在控制台「上游」展开「全局上游代理」，可以为当前组织设置 HTTP、HTTPS 或 SOCKS5 代理。新增和编辑上游时，可选择跟随全局、使用独立代理或强制直连。列表上的标签会标明生效方式；代理地址必须能从网关服务器访问，目标域名由代理解析，账号密码分别填写，密码加密保存且不回显。

保存后可用「连续测试网络」建立三次连接，查看本次连通率、平均和最快／最慢耗时。该测试不发起模型推理；收到 401、403、404 等响应会说明网络已连通但服务尚未验证。要核对模型列表和密钥，请继续使用供应方的「测试连接」；短时采样不能证明长期稳定。
