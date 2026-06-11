| feat | prd-admin | MD转PPT 新增生成引擎切换（MAP直调 / CDS Agent），默认走 MAP 直调路径 |
| feat | prd-api | MD转PPT MAP直调引擎：通过 ILlmGateway.StreamAsync 直接流式生成，不经过 CDS Agent |
| fix | prd-api | MD转PPT CDS Agent 路径改用 DenyAll toolPolicy，修复因 tool-call 循环导致的 HTTP 524 超时 |
| feat | prd-api | MD转PPT Agent 路径新增全链路诊断：per-stage 耗时/事件计数/tool-loop 告警，通过 diag SSE 事件实时推送前端 |
| feat | prd-admin | MD转PPT 前端实时展示 diag 诊断面板，CDS Agent 引擎下颜色编码显示各阶段耗时与 tool-call 次数 |
