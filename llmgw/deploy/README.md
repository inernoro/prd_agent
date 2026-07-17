# 部署边界

Gateway 的集成部署 SSOT 仍位于仓库根目录：

- `docker-compose.yml`：生产容器拓扑。
- `docker-compose.dev.yml`：本地开发拓扑。
- `cds-compose.yml`：CDS 源码与预构建模式。
- `.github/workflows/branch-image.yml`：三个 Gateway 镜像的构建入口。

源码上下文分别为 `llmgw/console-api`、`llmgw/web` 和仓库根目录下的 `llmgw/serving/Dockerfile`。镜像名、服务名、端口和公开 URL 保持不变。

## 三层入口

| 环境 | 控制台入口 | 说明 |
|---|---|---|
| 正式 MAP | `https://map.ebcone.net/llmgw/` | 当前正式入口，外层 Nginx 去掉 `/llmgw/` 后转给宿主机 `8081` |
| CDS main | `https://main-prd-agent-llmgw-web.miduo.org/` | `llmgw-web` 命名服务子域，不经过 Admin 的 `/` 兜底 |
| 独立品牌域名 | 例如 `https://sirius.ebcone.net/` | 域名根路径直接转给宿主机 `8081`，不再带 `/llmgw/` |

三种入口使用同一套 `llmgw-web`、Console API 和 Serving。未登录时只显示匿名健康状态和登录说明；租户、请求、密钥、模型与费用必须在登录后按服务端会话解析，不能为了“页面有数据”而匿名泄露。

## 独立域名接入顺序

1. 在权威 DNS 创建 `A` 记录，把目标域名指向正式机公网 IP。不要先写 Nginx 后宣称域名已上线。
2. 等公共 DNS 查询返回目标 IP后，为新主机名单独签发证书。`map.ebcone.net` 的单域名证书不能覆盖 `sirius.ebcone.net`。
3. 复制 `public-domain.nginx.example.conf`，替换主机名、证书路径和站点目录。
4. 执行 `nginx -t`，通过后 reload。不得重建 `prdagent-gateway`，避免反向代理目标变化造成 502。
5. 依次验收根页、实际 JS/CSS、`/gw/healthz`、`/gw/v1/healthz`，再验证四协议无 key 均为 401。
6. 登录后刷新首页、Activity、Quickstart 和费用页，确认同一租户的真实记录仍可见。

上线前可先验证宿主机代理，不依赖 DNS：

```bash
curl --resolve sirius.ebcone.net:80:43.136.77.61 http://sirius.ebcone.net/
```

证书签发后再用 HTTPS 复验；不得通过 `-k` 把证书错误当成通过。

## 测试环境数据口径

“有真实数据”不是在前端写死示例数字。至少应有一组通过控制台和 Gateway 正常接口创建、存入 CDS Mongo、刷新后仍存在的数据：租户、成员、appCaller、service key 元数据、一次成功请求、请求日志和费用状态。密钥明文只在创建瞬间显示，后续页面只显示后四位或“已配置”。

付费调用仍受限：每类真实协议最多一次，其余使用 MAP 公开测试桩或宿主机假上游。验收脚本 `scripts/llmgw-prod-governance-acceptance.sh` 默认 dry-run，执行时使用假上游且自动清理临时记录；它验证安全和稳定性，不承担长期演示数据初始化。长期演示数据应通过 Quickstart 正常创建并明确标记所属测试租户，禁止直接复制生产租户数据。
