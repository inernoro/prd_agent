| fix | prd-api | CDS Agent 事件流不再注入每条消息的传输内幕 debug 日志（cds-session-transport/operator-debug-only），移到服务端日志，消除用户事件时间线刷屏 |
| fix | prd-admin | CDS Agent「同步系统主模型」按钮改为「一键启用默认模型」+ 解释 tooltip（说明何时/为何出现），消除莫名其妙的困惑 |
| fix | prd-api | CDS Agent 改为真流式：ImportCdsStreamEventsAsync 增量读取 CDS SSE（边读边落库），前端 /stream 实时转发逐字呈现，消除「不流式 / 很久不返回」 |
| fix | prd-api | CDS Agent 发送不再卡死：SendMessage 把消息 POST 到 CDS 后立即入队返回，由 InfraAgentRuntimeWorker 后台拉流落库（与 HTTP 解耦，server-authority），消除「发送卡 2 秒→一直等→死掉」 |
| fix | prd-admin | CDS Agent 事件「详情」仅在展开后确有内容时才显示，空 payload 事件不再展开成「{}」/空（修复"展开折叠没内容"） |
| feat | prd-api | CDS Agent 新增工作区文件注入接口 POST /api/infra-agent-sessions/{id}/inject-files（path 1 接缝 v1，复用 CDS files 端点，不改边车镜像），用于把知识库文件喂给 agent 处理 |
| fix | prd-admin | CDS Agent 输入区重做：真输入框做成醒目带边框可输入+自动聚焦，去掉看着像输入框的提示框，修复"框选错半天无法输入" |
| fix | prd-admin | CDS Agent 新建会话不再起怪名「远程巡检任务」，默认从首条消息自动命名（留空→「新会话」） |
| fix | prd-admin | CDS Agent 对话流隐去纯内部状态/日志气泡（后台状态 running/dispatching run/陈旧用时），只保留用户/Agent消息+工具/错误/审批；运行状态看右侧面板 |
| fix | prd-admin | CDS Agent 简洁模式右栏精简：Git/证据/运行摘要/调试 等运维遥测收起，只留「准备情况/运行进展」，让简洁模式回归纯净聊天（用户心智：这是聊天不是运维台）；专业模式不变 |
| fix | prd-admin | CDS Agent 回复按 markdown 渲染：本轮收到 done 即渲染（不再因会话持续 live 而一直纯文本展示 ##/**/反引号） |
| fix | prd-admin | CDS Agent 输入区按 Codex 极简：去掉「官方 SDK」徽标+「不要求仓库…」说明+冗余提示，Code 巡检改名「代码」，思考指示改「Agent 思考中…」 |
| feat | prd-admin | CDS Agent 输入栏加模型选择器（参照 Codex）：新会话可直接选模型（解决配了 v4 却跑 v3.2 → 选对的那个），运行中显示当前模型 |
| feat | prd-admin | CDS Agent 展示思考过程：推理模型 thinking 内容流式显示在「Agent 思考中」气泡，消除推理期间空白 |
| feat | cds | CDS Agent 边车 sdk_events 映射 thinking 块 + remote-hosts 透传 thinking 事件给 MAP（原先只透 text_delta/tool_use/tool_result，思考被丢弃） |
| feat | cds | CDS Agent 边车 agent_loop 两条上游链路都透出思考：raw-anthropic 识别 thinking_delta；openai-compatible(OpenRouter) 请求体加 include_reasoning/reasoning + 解析 reasoning/reasoning_content，根治「等 40 秒才出第一个字」 |
| feat | prd-api | CDS Agent MAP 端打通 thinking 事件：SidecarEventType/InfraAgentRuntimeEventType/InfraAgentEventTypes 三处枚举补 Thinking，direct-sidecar 路径 switch 落 thinking 事件（不计入 finalText），CDS-managed 路径本就透传 |
| fix | prd-admin | CDS Agent 输入框不再发送后从中间跳到底部:输入区永远停底部(空状态也在底部),中间只放引导;根治布局跳变 |
| fix | prd-admin | CDS Agent 流式回复 markdown 不再「结束啪一下变样」:同一个 StreamingText 贯穿流式→完成两阶段(blur 过渡),不再换组件硬切 |
| fix | prd-admin | CDS Agent 右栏「结果可复盘」不再显示原始事件序号(一句闲聊刷几十个事件的噪音),改为「回复已生成」/真实产物数 |
| fix | prd-admin | CDS Agent 等待文案收敛:有思考显示「正在思考」,否则「正在生成回复」,「推理较慢」提示仅在等待≥15s 才出,不再一上来吓唬人 |
| fix | prd-admin | CDS Agent 右栏不再把「运行日志」当产物:纯聊天不再误报「1个产物」,真实文件/diff/命令/快照才计入产物数 |
| fix | prd-admin | CDS Agent 发送后消息不再「闪一下消失再出现」:乐观消息改 null 绑定(不再误绑到超时旧会话)+按内容(剥模式前缀)与服务端消息去重,新建会话切换也无空窗 |
| fix | prd-admin | CDS Agent 发送时不再弹「正在发送任务/复制诊断」开发者卡片:该诊断卡仅失败时出现,正常进度由对话气泡+右栏承载 |
| fix | prd-admin | CDS Agent 无模型配置时自动启用系统默认主模型(静默,失败保留手动按钮兜底):刷新后不再卡在「请先同步系统主模型」三连警告 |
| fix | prd-admin | CDS Agent 兑现「回车发送」:输入框此前没有 onKeyDown,回车只换行不发送;补 Enter 发送(Shift+Enter 换行,输入法组字回车不误发) |
| fix | prd-admin | CDS Agent 输入区抄 Codex 融合一体:模式/模型/停止/发送合并到输入框底栏一行,textarea 无边框透明融入容器,去掉顶部独立 tab 行+分隔线+提示文案,发送改圆形箭头,不再臃肿拆分 |
| fix | prd-admin | CDS Agent 右栏「准备情况/运行进展」可折叠(顶栏按钮):折叠后聊天主区占满宽度,借鉴 Codex 右侧不占固定栏 |
| fix | prd-admin | CDS Agent 刷新后不再 10 秒空白:首屏 loadAll 期间主区显示加载动画(MapSectionLoader),不再空等 |
| fix | prd-api | CDS Agent 会话一轮回复结束(done)即转 idle(可复用、不计时超时),不再停留 running 直到超时:根治「历史消失(每次发送新建会话)」+「任务列表全是新会话已超时尸体」;CDS-managed 与 direct-sidecar 两条路径都修;done 后停止拉流释放 worker |
| fix | prd-admin | CDS Agent 输入框选中高亮走外层容器(focus-within ring),不再高亮内层 textarea(符合 surface 选中规则) |
