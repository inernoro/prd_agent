| fix | prd-api | MD转PPT patch 页码归一:前端"指定第几页"是 1-based 原样下发,后端原先又 +1(输入 3 改成第 4 页)、留空写成"第 0 页";改为直接用 1-based 页码,留空时提示"按要求修改整份 PPT" |
| fix | cds | 修复 CDS Agent 会话可观测面板:事件字段对齐后端真实形状(payload/createdAt,原误写 data/ts 导致时间 Invalid Date、摘要永远为空)、tool 事件读 toolName、过滤流末尾 keepalive 垃圾行、新增思考事件标签 |
| fix | cds | CDS Agent 会话详情改为按 afterSeq 持续重连轮询:CDS stream 端点是一次性(回放缓冲事件+keepalive 后即 Connection:close),运行中会话单次读完即假死,现轮询到终态事件才停 |
| fix | cds | CDS Agent 会话列表 5s 自动刷新改 silent(不再每 5 秒闪 loading 骨架) + loadSessions 加 fetchSeq 守卫(切项目时旧请求晚返回不再覆盖新列表) |
| fix | cds | 修复 Agent 会话端点跨租户越权:authenticateProjectRequest 原把所有 _aiSession 当 admin 等价放行,导致项目级 Agent Key(cdsp_*)改 URL 里的 projectId 就能列/控制别的项目的 Agent 会话;改为项目级 key 强制 cdsProjectKey.projectId === 路由 projectId,全局超级密钥与人类 cookie 仍放行 |
| fix | cds | self-update boot 预检(#746 guard#3)不再重复 install:仅当 runPnpmInstallWithCache 命中缓存跳过真实 install 时才补跑 boot 预检;helper 本轮已用同一条命令真实跑过则不再跑第二遍(省双倍 install 时间、避免第二次偶发失败误伤) |
| fix | cds | self-update boot 预检测试随 guard#3 条件化更新:本 mock 无 lockfile stamp(install 真实跑)时 cdsDir 命令数从 3 改为 2(真实 install + tsc),boot 预检仅在缓存跳过时补跑 |
| fix | prd-api | MD转PPT CDS Agent 引擎补齐 server-authority:客户端断开时 SSE 心跳写失败不再 break(原会提前掉进超时分支落半成品 HTML 并 StopAsync 掉还在跑的会话),改标记 clientGone 继续轮询到 done/error/timeout 完整落库,客户端凭 runId 重连 |
| fix | prd-admin | CDS Agent code 模式「知识库/工作区」selector 暂禁用并标注「开发中」:后端尚无把知识库灌进 Agent 会话上下文的能力,createInfraAgentSession 也无此字段,避免"选了却不生效"误导(债务见 doc/debt.md-to-ppt.md) |
| fix | prd-admin | 知识库再加工确认窗写回失败不再误关:performApply 返回写回成功与否,confirmPendingApply 仅成功才关 diff 预览,失败时保留预览供用户直接重试 |
