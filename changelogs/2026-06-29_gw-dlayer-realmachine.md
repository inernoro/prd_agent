| test | prd-api | 网关 D 层真机跑通：CDS 自更新到 main 取多容器能力后，用分支级额外服务把 llmgw-serve 作为单分支第 3 容器部署（/gw/v1 最长前缀路由 + Mongo 模板 env 部署期展开），scripts/gw-smoke.py 对实时预览 8/8 绿（pools/send 真打 qwen/deepseek + canary 必败被抓） |
| fix | prd-api | gw-smoke.py 补浏览器 User-Agent 头，绕过预览 Cloudflare 对 Python-urllib UA 的 1010/403 拦截 |
