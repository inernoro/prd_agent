| fix | prd-api | 修复 MD转PPT SSE 两个引擎(MAP/CDS Agent)均 524 超时：SetSseHeaders 不再手动写 Transfer-Encoding: chunked(由 Kestrel 管理)，与既有 SSE 控制器一致 |
| fix | prd-api | MD转PPT SSE 末尾一次性吐出：补 IHttpResponseBodyFeature.DisableBuffering() 禁用 Kestrel 响应缓冲(与既有 SSE 控制器一致) + Cache-Control no-transform + 2KB padding |
| fix | cds | 修复 pnpm-workspace.yaml allowBuilds 占位字符串导致 master-run 启动崩溃：pnpm 11 把未批准的 native build(cpu-features/esbuild/ssh2)当 fatal(ERR_PNPM_IGNORED_BUILDS exit 1)→ exit 78 崩溃循环；改为 allowBuilds:true 显式批准 |
| feat | cds | #746 self-update 加固：guard#3 boot-install smoke(swap 前用 master-run 确切命令跑真实 pnpm install，挡住"编译过但启动崩"，两次 502 都是从 cached-install skip 缝里溜过) + guard#2 分支落后 main 非阻断警告 |
| fix | cds | 修复 Sidecar Pool 观测面板对仪表盘操作者永远 401：agent-sessions 端点的 authenticateProjectRequest 只认 Bearer 连接 token，浏览器带的是 cds_token cookie；改为人类 cookie 登录(_cdsCookieAuth)/AI 超级密钥(_aiSession)等 admin 等价会话直接放行 |
| fix | prd-api | 大幅提升 MD转PPT 生成质量：内置完整 reveal.js 设计系统提示词(卡片/数据/光晕/强调条) + 强制每页结构杜绝空洞页；标题改实色(原渐变 color:transparent 在嵌入式渲染会整页消失) + 服务端兜底剥离 emoji(规则#0) |
| fix | prd-admin | 修复 MD转PPT 预览里递归显示整个 MAP 应用而非幻灯：iframe sandbox 去掉 allow-same-origin(生成 HTML 跑在本应用同源里，reveal 的 history/相对跳转会把 iframe 导航回应用 /) + onDone 校验返回的确实是网页 PPT(非 SPA 外壳/空内容) |
