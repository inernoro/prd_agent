| fix | prd-api | CDS Agent 事件流不再注入每条消息的传输内幕 debug 日志（cds-session-transport/operator-debug-only），移到服务端日志，消除用户事件时间线刷屏 |
| fix | prd-admin | CDS Agent「同步系统主模型」按钮改为「一键启用默认模型」+ 解释 tooltip（说明何时/为何出现），消除莫名其妙的困惑 |
| fix | prd-api | CDS Agent 改为真流式：ImportCdsStreamEventsAsync 增量读取 CDS SSE（边读边落库），前端 /stream 实时转发逐字呈现，消除「不流式 / 很久不返回」 |
| fix | prd-api | CDS Agent 发送不再卡死：SendMessage 把消息 POST 到 CDS 后立即入队返回，由 InfraAgentRuntimeWorker 后台拉流落库（与 HTTP 解耦，server-authority），消除「发送卡 2 秒→一直等→死掉」 |
| fix | prd-admin | CDS Agent 事件「详情」仅在展开后确有内容时才显示，空 payload 事件不再展开成「{}」/空（修复"展开折叠没内容"） |
| feat | prd-api | CDS Agent 新增工作区文件注入接口 POST /api/infra-agent-sessions/{id}/inject-files（path 1 接缝 v1，复用 CDS files 端点，不改边车镜像），用于把知识库文件喂给 agent 处理 |
| fix | prd-admin | CDS Agent 输入区重做：真输入框做成醒目带边框可输入+自动聚焦，去掉看着像输入框的提示框，修复"框选错半天无法输入" |
| fix | prd-admin | CDS Agent 新建会话不再起怪名「远程巡检任务」，默认从首条消息自动命名（留空→「新会话」） |
