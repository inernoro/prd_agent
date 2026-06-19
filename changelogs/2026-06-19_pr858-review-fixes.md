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
