| security | prd-llmgw | 生产环境强制显式配置 LLMGW_JWT_SECRET / LLMGW_ADMIN_PASSWORD（缺失或为仓库 dev 占位值则拒绝启动），防止 /gw/* 被自签 token 读取 |
| security | prd-api | docker-compose 的 LLMGW_JWT_SECRET 改为必填（删除空默认），与 SERVE_KEY/ADMIN_PASSWORD 对齐 |
| fix | prd-api | 修复 blackhole 日志误标成功调用：StartAsync 失败返回 null 使记录不被覆盖/反向误标，移除 Status 兜底过滤 |
| fix | prd-admin | LLM 日志 blackhole 状态标签「未发出」改为「记录降级」（请求可能已成功，仅日志未落库） |
| fix | prd-llmgw | LLM 日志 blackhole 状态标签「未发出」改为「记录降级」 |
| fix | prd-api | http 模式 multipart raw（ASR/图生图）跨进程未接通时快速失败（MULTIPART_HTTP_UNSUPPORTED），防止静默发出丢文件的请求 |
| fix | cds | compose cds.subdomain 重复声明时去重（首个保留，后续丢弃），forwarder 命名子域去重按 profileId 排序保证确定性 |
| fix | cds | master 命名子域兜底增加状态门控：仅 hostPort>0 且状态可路由(running/starting/building/restarting)的服务才命中命名 host，停止/错误服务不再被强制为坏上游(与 forwarder 共用 ROUTABLE_SERVICE_STATUSES) |
| fix | ops | exec_dep.sh 默认 PRD_AGENT_LLMGW_IMAGE 改指向独立 prdagent-llmgw 镜像（原误用 api 镜像导致 llmgw 服务错跑 PrdAgent.Api.dll、/gw/* 端点全缺） |
| fix | ops | docker-compose gateway 发布 8081 端口，让 standalone 部署能打开网关前端控制台（_standalone.conf 的 llmgw-web listener） |
| docs | ops | debt 记录命名子域 master 反代兜底两处已知局限（widget header scope / 分支级门控），标注 forwarder 生产路径完整可用，波3 补 |
| security | cds | CDS 预览网关 console(/gw/)+serving(/gw/v1/) 改为仅内网不公开路由，关闭用仓库已知 dev 密钥从公网登录读日志/调用 provider 额度的暴露（公开命名 URL 留波3 配 per-deploy 密钥） |
| fix | prd-api | 影子 resolve 比对改用 GetEffectiveExpectedModel（含 RequestBody[model] 回退），消除 model 只放 body 时的假阳性 critical mismatch |
| fix | scripts | 去除 gw-matrix 报告脚本测试向量里的 emoji/符号（U+2728 / U+2713），换非 emoji 非 ASCII 样本（拉丁重音/CJK），合规规则 §0 |
| docs | ops | debt 记录 Claude OpenAI 兼容工具链不完整（流式 tool_use/tool_choice:none/tool_result 多轮三处合并波3 专项） |
