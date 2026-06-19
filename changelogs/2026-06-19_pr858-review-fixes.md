| fix | prd-api | 额度判定排除限流误报：429 / "Rate limit exceeded" / "requests per minute" 等节流不再被当成额度用尽（LLM_QUOTA_EXCEEDED 误触发额度告警）；额度只认 key/credit/quota/balance/billing 明确信号 |
| fix | prd-admin | 视觉分镜台并发竞态修复：每轮「生成分镜」自增 genRef 作废上一轮在途关键帧 SSE 与图生视频轮询（stale-response guard），旧回调不再画到新分镜板同 sceneIndex；创建关键帧任务无 runId 时复位 spinner 为 error；同镜正在转视频时禁止重复触发「动起来」 |
| fix | prd-admin | 视觉分镜台图生视频改走 visual-agent 自有端点（/api/visual-agent/video-gen/runs，appKey=visual-agent），避免 visual-agent-only 账号撞 video-agent 403、并用本应用配额/appKey（遵循 app-identity 规则） |
| fix | prd-admin | 图生视频轮询：客户端窗口 6→11 分钟以覆盖后端 worker 10 分钟终态期，避免 6-10 分钟才完成的视频被误判「生成超时」；提交失败/超时回填补 genRef 守卫，旧板任务不再误标新板场景 |
| fix | prd-api | OpenRouter 图片回退收窄：images/generations 失败回退 chat/completions 仅在非鉴权(401/403)/额度(402)/限流(429)时触发，避免真实上游错误被改协议重试覆盖+徒增流量 |
| fix | prd-admin | 视觉分镜台卡片渲染按 vidStatus 优先：重绘关键帧时清空旧视频状态，且 vidStatus 为 running/error 时不再显示上一版成片——重生视频能正常显示进度/失败 UI，用户可核对新关键帧 |
| fix | prd-api | 图生视频 worker 按 run.AppKey 选 caller：visual-agent 分镜台创建的 run 归属 visual-agent 视频配额/模型池与日志归因（新增 AppCallerRegistry.VisualAgent.VideoGen.Generate），不再一律记到 video-agent |
| fix | prd-api | 分镜脚本 JSON 提取改用括号深度匹配（字符串内花括号不计 + 去 markdown 围栏），替代「首 { 到末 }」贪婪截取，模型夹带说明文字/值含 } 时不再「分镜解析失败」 |
| fix | prd-admin | 该镜正在转视频时禁用「重绘」并在 regenerateScene 早退：单镜重绘不 bump genRef，旧 animateScene 轮询会用上一帧成片覆盖刚重绘的新关键帧，故视频生成中不允许重绘（Codex review） |
| fix | prd-admin | 视觉分镜台关键帧放大预览改用 createPortal 挂到 document.body，遵循 frontend-modal.md（避免 overflow/transform 祖先裁剪 position:fixed 浮层）（Codex review） |
| fix | prd-admin | 关键帧批次与单镜重绘并发隔离：新增 per-scene 运行 token（sceneKfGen），后发重绘顶替该镜所有权，使先前批次对该镜的 SSE 回填/流结束兜底变 no-op，避免「批次仍在跑、其中一镜被重绘」时批次兜底把正在重绘的镜误判失败（Bugbot review） |
| fix | prd-admin | 图生视频沿用关键帧出图画幅：SceneVM 记录 kfAspect，animateScene 用 s.kfAspect 而非全局 aspect，避免用户改画幅后用旧帧出错比例（Codex review） |
| feat | prd-api | 放开视觉创作视频每日限额（DailyLimit 1→999，用户决定）：原 1/天「体验」限额会让多镜分镜每天只能动 1 镜，其余被配额 400 挡；放开后多镜分镜可逐镜出视频 |
| fix | prd-admin | 分镜台卸载时 bump genRef 停止图生视频轮询（避免卸载后 setScenes）；分镜卡片按 s.kfAspect 取景（改全局画幅后旧镜不再被错误裁剪） |
| fix | prd-api | OpenRouter 出图回退进一步收窄为「仅端点缺失」(404/405/501)：原先非 400/413 等即回退，对非 OpenRouter 平台(如 Volces)瞬时 5xx 会用错协议重打、覆盖真实错误（Codex+Bugbot 双标），现只在端点确实不存在时回退 |
| fix | prd-admin | handleGenerate 补 stale 守卫：拆分镜 await 返回后校验 genRef，卸载/新一轮已作废时丢弃过期脚本响应，不再 setTitle/setScenes/启动 renderKeyframes |
| fix | prd-api | 拆分镜接口转发 gateway 中文报错：原先失败统一回 `分镜生成失败：{ErrorCode}` 丢掉 ErrorMessage，额度等错误的 LLM_QUOTA_EXCEEDED 中文文案被吞成泛化提示，现转发 ErrorMessage + 透传 gateway ErrorCode（Bugbot review） |
| fix | prd-api | LlmGateway.StreamAsync 非 2xx 分支补额度检测：原先只有非流式 SendAsync/Raw 路径调 IsQuotaExceeded/HandleQuotaExceeded，导致 toolbox/defect/literary/polish 等主聊天(走 StreamAsync)遇 OpenRouter 402 / Key limit exceeded 不触发 admin 额度告警、不透传额度文案，现对齐（Codex review） |
| fix | prd-admin | 分镜台「动起来」补同步去重：vidStatus='running' 是异步 state，两次快速点击会在落地前都通过守卫、重复提交后端视频 run + 叠加轮询，改用 animatingRef Set 同步拦截（Bugbot review） |
| fix | prd-admin | 分镜台挂载拉取生图模型补 alive 守卫：卸载/重挂后丢弃过期响应，不在已卸载组件上 setPools/setModelsLoading（Bugbot review） |
| fix | prd-api | 额度告警改 await 写入：IPoolFailoverNotifier 为 Scoped、持 scoped MongoDbContext，原 fire-and-forget 在 request/stream scope 释放后 upsert 会被取消/off-thread 失败，恰在 402/额度用尽时丢告警，现 await 确保 scope 存活期内写完（Codex review） |
| fix | prd-admin | 分镜台关键帧提示词改后标 kfDirty：出图后编辑提示词不再静默沿用旧帧，转视频前强制重绘，避免「旧首帧 + 新提示词」出错配视频（Codex review） |
| fix | prd-admin | 分镜台「动起来」锁改为按 genRef 代次记账：重新生成分镜后旧板未结束的视频轮询不再占用相同 sceneIndex 导致新板动起来静默无响应；旧轮询 finally 仅在仍持本代次锁时释放，不会清掉新板锁（Bugbot review） |
| fix | prd-api | IsQuotaExceeded 去掉「429 一律 false」短路：部分供应商(如 OpenAI insufficient_quota)用 429 返回额度耗尽，原短路使其漏掉额度告警走泛化 LLM_ERROR，改为只按速率文本排除限流，额度文本(quota/credit/balance)继续判定（Codex review） |
| fix | prd-api | 分镜 title/topic/keyframePrompt/motionPrompt 落库前剥 emoji + system prompt 加无 emoji 约束：LLM 返回的标题会直接渲染进页头，违反 CLAUDE.md §0 禁 emoji（Codex review） |
| fix | prd-admin | 分镜台「动起来」提交后若被新一轮生成/卸载作废，取消刚创建的视频 run（新增 cancelVisualVideoRunReal 走 visual-agent cancel 端点），避免后台继续烧视频额度且结果已无法回到 UI（Codex review） |
| fix | prd-admin | 分镜台视频轮询期间作废也取消后端 run：上一轮只在轮询开始前取消，轮询中的 genRef 守卫直接 return 不取消，worker 仍烧额度。抽 bailIfStale 统一在所有 stale 退出点取消（Bugbot review） |
| fix | prd-admin | 关键帧 dirty 判定改按提示词比对：渲染途中改词后，旧提示词的图到达时不再无条件清脏，仅当当前词仍等于已出图的词才清，避免旧帧配新词被当干净帧（Codex review） |
| fix | prd-admin | 分镜台关键帧模型选择改用 text2img 专属池端点（/models/text2img），不再用合并了 img2img/vision 的列表，避免选到只配了 img2img/vision 的池导致每帧失败（Codex review） |
| fix | prd-api | 图生视频直出 worker 提交前补取消闸：CancelRunAsync 仅设 CancelRequested，而 claim 只过滤 Status==Queued，取消的 run 仍可能在 worker 提交到 OpenRouter 后才被轮询取消、白烧额度。ProcessDirectVideoGenAsync 领取后 + 提交前两处检查 CancelRequested，命中即置终态不提交（Codex review） |
| fix | prd-api | 分镜台 ExtractChatText 兼容数组型 content：部分 chat 网关把 message.content 返回为部件数组 [{type:text,text:..}]，原先只当字符串读会抛异常退回整段响应、导致 JSON 提取抓到外层 envelope 而非分镜对象、报通用解析失败。改为字符串/数组两种形态都正确拼接文本（Bugbot review） |
| fix | prd-api | ExtractChatText 再兼容单对象型 content：网关把 message.content 返回为单个 {type,text} 对象（非数组）时也能取文本，抽 PartText 助手统一处理 字符串/单对象/数组三形态（Bugbot review 续） |
| fix | prd-api | 分镜解析截断至 MaxStoryboardScenes(12)，与请求侧 sceneCount 钳制共用常量：模型对长文超产时不再全量下发撞图生图 run 条目上限导致整板无关键帧（Codex review） |
| docs | prd-agent | debt.cds-backend-deploy-freeze.md 移除 3 个裸 NUL 字节(改字面 \0)，使 git 不再把该 md 当二进制、diff 工具可正常处理（Codex review） |
| polish | prd-admin | 分镜台拆分镜等待加预估耗时文案(10-40s)，补全 CLAUDE.md §6 兜底(动画加载+预估耗时)；完整 SSE 流式见 debt #4（Codex review） |
| fix | prd-api | 图生视频 submit/status 失败转发 Gateway 额度文案：OpenRouterVideoClient 原先只从 Content/ErrorCode 构造错误，丢掉 SendRawWithResolutionAsync 已写入 ErrorMessage 的 LLM_QUOTA_EXCEEDED 中文提示。新增 QuotaOrUpstreamMessage：额度错误优先用友好文案、其余保留 /videos 上游解析，使「动起来」与拆分镜额度提示一致（Bugbot review） |
| fix | prd-admin | 关键帧 imageDone 但 url/base64 均缺时标 error 而非 done：原先无图也置 done、kfUrl 为空，卡片永远停在 shimmer（卡片仅在 done && kfUrl 才显示图）。改为无图即 error 提示重绘（Bugbot review） |
| fix | prd-api | 图生视频下载失败路径也走 QuotaOrUpstreamMessage：原先只用 ErrorCode/HTTP 状态+诊断，丢掉 Gateway 的 LLM_QUOTA_EXCEEDED 友好文案，与 submit/status 不一致（Bugbot review） |
| fix | prd-api | 分镜解析按请求 sceneCount 截断：ParseStoryboard 接收 maxScenes(用户指定 N 则裁到 N，否则全局上限 12)，兑现 system prompt「恰好 N 个」、控制下游关键帧批量与成本（Bugbot review） |
| fix | prd-api | OpenRouter 生图解析回退兜底：启发式(body 含 choices/image_url/images 子串)命中但解析到 0 张图时，不再立即失败，回退标准 data[] 解析，避免有效 images/generations 响应被误报「未包含图片数据」（Bugbot review） |
| ops | prd-api | cds-compose.yml 的 api 服务 build/run 显式统一 `-c Debug`：原先 build 与 dotnet run --no-build 都依赖默认配置，缺显式 -c 易漂移(build 出 Release 而 run 加载 Debug → 跑旧程序集，正是部署冻结症状)（Bugbot review） |
| fix | prd-admin | 分镜「动起来」视频轮询超时改基于服务器状态：worker 串行处理，本镜排在长任务后会长时间 Queued，原按创建时间起算 11 分钟会在后端刚开始时误判超时。改为离开 Queued 才起算处理窗口(11min)，排队期单独按 20min 上限 + 「排队中」文案（Codex review） |
| fix | prd-api | OpenRouter/标准 data URL 生图保留 MIME：data:image/jpeg|webp 原先只剥 base64、丢 MIME，落库用默认 image/png，导致 COS 存成 png 却是 JPEG/WebP 字节。ImageGenImage 加 Mime 字段，解析时取 data URL 头 MIME，上传时据此设 outMime（Bugbot review） |
