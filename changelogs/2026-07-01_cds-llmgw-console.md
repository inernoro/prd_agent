| feat | cds | 网关入口打开真实控制台 prd-llmgw-web（登录→LLM日志），替换 /gw/healthz 心跳落地：compose 新增 llmgw-web 预构建镜像服务（子域 llmgw-web）+ branches.ts 落地路径 llmgw-web→/ + BranchDetailDrawer 网关卡片分层（控制台主色置顶 / 引擎中性） |
| fix | cds | compose-parser 识别「预构建镜像 app 站点」：isAppServiceCandidate 对 image + cds.prebuilt-image + (cds.subdomain\|path-prefix) 判为 app（否则纯 nginx 前端站无源码 mount/无 build 被丢弃，命名子域永不发布）；ComposeServiceEntry/BuildProfile 支持基础级 fallbackImage 逐级回退 + 序列化跳过预构建站点的假源码 mount |
| fix | cds | computeProfileAliases 剥离完整项目 slug/id 后缀，llmgw-prd-agent→裸别名 llmgw（llmgw-serve→llmgw-serve、api→api…），让同分支网内 llmgw-web 的 nginx 反代 http://llmgw:8090 可解析（零回归，保留旧单段启发式） |
| fix | cds | prd-llmgw-web/nginx.conf 反代改运行时 DNS 解析（resolver 127.0.0.11 + 变量 upstream），消除 nginx 启动期缓存 llmgw IP 导致的「别名未就绪崩溃 / llmgw 换 IP 后持久 502」竞态 |
