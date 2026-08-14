| fix | prd-api | 锁定录音转写物理 Offering 并按最终模型生成兼容请求契约 |
| fix | prd-api | 区分可自动重试与需手动重试的转录失败终态 |
| fix | prd-api | 为后台转录维护 Worker 心跳并在手动重试前终结失联旧任务 |
| fix | prd-api | 以跨实例输出锁和代次栅栏阻止旧转录或旧整理覆盖新原文 |
| fix | prd-api | 隔离启动回收异常，避免知识库级任务拖停录音任务队列 |
| fix | prd-admin | 转录失败使用服务端终态时间并收敛后台任务看护 |
| fix | llmgw | 拒绝模型、协议与端点不兼容的 ASR Offering 配置及重新启用 |
| test | prd-api | 补齐 ASR 路由矩阵、Offering 锁定、参数兼容与失败分类回归 |
| test | prd-api | 补齐失联回收、并发输出、旧任务拒写与整理竞态的 Mongo 回归 |
| fix | prd-api | 修复跨进程固定 ASR 模型被网关按健康度重新选成其他协议模型 |
| test | prd-api | 补齐异构 ASR 池在前后端健康快照不一致时仍保持物理模型锁定的 Mongo 回归 |
| fix | prd-api | 修正备用实时转写首屏状态并将确认无人声归为不可自动重试终态 |
| test | prd-api | 补齐实时转写首屏状态与空转录停止重试的回归验证 |
| fix | prd-api | 拒绝将静音上游返回的独立助手拒答保存为录音原文 |
| test | prd-api | 补齐静音英文拒答、受控哨兵与真实引用句的正反回归 |
| fix | prd-api | 统一完整转录、实时回退与响应解析的无人声整句哨兵契约 |
| test | prd-api | 补齐 chat-audio 真实发言包含无人声关键词时仍保留正文的链路回归 |
| fix | prd-api | 在完整音频进入 ASR 前增加 PCM 信号门禁，阻止纯静音被模型幻觉成正文 |
| test | prd-api | 补齐规范化 WAV 对纯静音、长静音夹短人声、补白短句、音量边界与异常格式的确定性回归 |
| fix | prd-api | 录音任务代次发布在 run 插入失败时条件回滚，并对未知写入结果按 runId 幂等确认 |
| fix | prd-api | 正文发布后的版本快照失败不再把已成功的录音转录任务误标失败 |
| fix | prd-api | 为录音任务每次认领分配独立执行身份，阻止失联旧 Worker 写入新执行的心跳、进度、正文和终态 |
| test | prd-api | 补齐同 runId 重排后的旧执行身份栅栏 Mongo 并发回归 |
| fix | prd-api | 输出租约失效后立即熔断旧执行，并为中断恢复分配新正文代次防止迟到覆盖 |
| test | prd-api | 补齐租约过期接管与同 runId 新代次发布的真实 Mongo 并发回归 |
| fix | prd-api | 中断恢复在任务重排结果未知时按恢复身份幂等确认并安全回滚正文代次 |
| test | prd-api | 补齐输出租约过期接管后旧恢复者不得回滚、新恢复者幂等收敛的真实 Mongo 回归 |
| fix | prd-api | 中断恢复 marker 独立于心跳和旧终态持续收敛，并禁止普通执行改写协议中间态 |
| test | prd-api | 补齐旧心跳恢复和旧执行已终态时 pending marker 仍能重排的真实 Mongo 回归 |
| fix | prd-api | 首次转录任务改为 marker-first 两阶段发布，并由周期协调收敛未知 Mongo 写入结果 |
| test | prd-api | 补齐任务 marker 写入与回读双失败、重启续跑和唯一代次发布的真实 Mongo 回归 |
| fix | prd-api | 相同录音整理请求在 marker 后台收敛后复用原任务，避免 HTTP 重试重复推进代次 |
| fix | prd-api | 转录任务 marker 持久化独立代次目标，兼容源音频与旧版输出笔记分离的整理恢复 |
| test | prd-api | 补齐旧版独立转录笔记恢复只推进输出笔记且复用同一任务的真实 Mongo 回归 |
| fix | prd-api | 录音重试只复用仍持有当前输出代次的在途转录任务 |
| test | prd-api | 增加无主认领、当前实例复用与锁内代次重读的真实 Mongo 回归 |
| fix | llmgw | 标准 ASR 端点统一忽略尾斜杠和查询参数后再执行模型协议门禁 |
| fix | prd-api | 旧版转录笔记在整理发布复核时继续使用原任务保存的转录文本 |
| test | prd-api | 补齐 ASR 端点规范化与旧版整理原文回退的正反回归 |
| fix | prd-api | 仅剥离外围引号和终止标点后识别无人声整句哨兵，避免伪正文入库 |
| fix | prd-admin | 替代转录任务失联时保留可重试停滞错误而非静默撤销后台提示 |
| test | prd-api | 补齐无人声哨兵外围标点与真实句子包含标记的精确正反例 |
| test | prd-admin | 补齐旧转录被失联替代任务取代时的后台看护收敛回归 |
| fix | prd-admin | 将转录首次发布 marker 视为可恢复在途状态并纳入失联判定 |
| test | prd-admin | 补齐 publishing 状态刷新接管、停滞收敛与失败提示互斥回归 |
