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
