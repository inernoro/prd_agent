# CDS 双出口契约 + 容器拓扑透明

> 一个分支同时部署「主应用 + 独立网关」这类多容器工程时，对外必须是**两个独立 HTTPS 出口**（严禁 http 混入），且面板/文档必须**显式标注每个容器的职责**（谁是前端、谁是后端、谁是 serving、谁是共享 infra）。用户一眼就能看懂拓扑，而不是面对一堆匿名容器猜。
> 触发：任何单分支多容器部署（网关剥离、微服务拆分、独立观测前端等）。

---

## 历史背景（本次痛点）

网关剥离后，一个分支里同时跑着 MAP 后端（prd-api）、MAP 前端（prd-admin）、网关 serving（prd-llmgw，8091）、网关观测前端（prd-llmgw-web），外加共享的 Mongo / Redis。用户面对 CDS 面板上的一排容器，分不清哪个是干嘛的、网关到底从哪个 URL 进、是不是每个出口都是 HTTPS。「双出口是不是两个都走 HTTPS」「redis/mongo 是不是共享的」这些本该一目了然的事，用户得反复问。剥离的价值之一就是「网关有独立入口、可被别人调用」——入口不透明，这个价值就打了折。本规则把「双出口 + 拓扑透明」固化为多容器部署的交付契约。

---

## 强制条款

### 1. 双出口必须是两个独立 HTTPS，禁止 http 混入

- 主应用与网关（或任意两个对外部件）各自拥有**独立命名子域**，走 CDS v3 子域路由：`<slug>-<sub>.miduo.org`（`BuildProfile.subdomain` + forwarder 命名 host 路由）。网关入口是独立子域，**不是**埋在主应用域名下的 `/gw/v1` path-prefix。
- 两个出口**全部 HTTPS**。任一出口出现 `http://`（含内部转发对外暴露、混合内容）即违规，必须修到全 HTTPS。
- 交付时给出**每个出口的最终深链**（落到该出口用户会看的那一屏，见 `CLAUDE.md §11`），不是只给根域名。

### 2. 每个容器职责必须在面板/文档显式标注

多容器部署的看板/拓扑说明里，逐个容器标注：**容器名 → 角色 → 对外/对内 → 出口 URL（若对外）**。角色枚举至少覆盖：

| 角色 | 说明 | 本次实例 |
|---|---|---|
| 前端（web） | 用户直接访问的 UI | prd-admin（MAP 前端）、prd-llmgw-web（网关观测前端，自带登录） |
| 后端（api） | 主应用业务 API | prd-api（MAP 后端） |
| serving | 独立可被调用的服务引擎 | prd-llmgw（网关 serving，8091，`/gw/v1/*`，X-Gateway-Key 门） |
| 共享 infra | 跨部件共享的基础设施 | Mongo（**不分离**，两侧共享同一库）、Redis |

- **共享 infra 必须显式说明「谁在共享它」**：网关剥离**不分离数据库**，serving 与 MAP 读写同一个 Mongo——这一点必须写明，否则排障时会误判数据来源（呼应 `cross-project-isolation.md` 通道 4：共享 Mongo/Redis，A 写坏 B 立刻可见）。
- 匿名容器（面板上只有一串 id、没有角色标注）不允许作为交付终态。

### 3. 网关多容器的命名 / 数量契约

- **命名契约**：serving 容器名以 `prd-llmgw` 为前缀、观测前端以 `prd-llmgw-web` 为前缀；主应用维持 `prd-api` / `prd-admin`。命名即角色，禁止随机名。
- **数量契约**：网关部件在一个分支里的对外容器数量是确定的（serving 1 + 观测前端 1），对应 2 个 HTTPS 出口。数量变化（加副本、加容器）必须更新拓扑说明并说明原因，禁止悄悄多出一个没人认识的容器。
- 出口 URL 走 cdscli SSOT，不自己 slugify（`CLAUDE.md §11`：只跑 `cdscli --human preview-url` 取根域名，子域/路径按真实路由追加）。

### 4. 拓扑说明挂进状态看板

把「容器角色表 + 两个出口 URL + 共享 infra 说明」放进该工程状态看板（`living-status-board.md`），作为交付/验收时的拓扑真相，用户不必去 CDS 面板逐个猜。

---

## 自查清单（多容器部署交付时）

- [ ] 对外是两个独立 HTTPS 出口，各有命名子域，没有任何 http 混入？
- [ ] 每个容器都标了角色（前端/后端/serving/共享 infra），没有匿名容器？
- [ ] 共享 infra（Mongo/Redis）写明了「谁在共享、数据库不分离」？
- [ ] 网关容器命名合契约（prd-llmgw / prd-llmgw-web）、数量确定？
- [ ] 出口 URL 走 cdscli 取根域名、给到落地深链，不是自己拼、不是只给根域名？
- [ ] 拓扑说明挂进看板了？

---

## 与既有规则的关系

- `cross-project-isolation.md`：共享 Mongo/Redis 是已知隔离通道；本规则强制「共享 infra 显式标注」，让排障时不误判数据来源。
- `CLAUDE.md §11`（预览地址）：出口 URL 走 cdscli SSOT + 落地深链，禁自己 slugify。
- `cds-auto-deploy.md`：push 即部署 + 分支状态 SSE；本规则补「多容器部署时每个容器职责要透明」。
- `living-status-board.md`：拓扑说明挂进看板。
- `content-fills-canvas.md` / `full-height-layout.md`：观测前端（prd-llmgw-web）等 UI 出口本身也要满足内容填满 / 撑满高度。
- 本次实例：`doc/plan.llm-gateway.rollout.md`（波2.5 CDS 命名子域）、`doc/design.llm-gateway-physical-isolation.md`。
