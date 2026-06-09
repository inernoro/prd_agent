| fix | prd-api | MD转PPT patch 页码归一:前端"指定第几页"是 1-based 原样下发,后端原先又 +1(输入 3 改成第 4 页)、留空写成"第 0 页";改为直接用 1-based 页码,留空时提示"按要求修改整份 PPT" |
| fix | cds | 修复 CDS Agent 会话可观测面板:事件字段对齐后端真实形状(payload/createdAt,原误写 data/ts 导致时间 Invalid Date、摘要永远为空)、tool 事件读 toolName、过滤流末尾 keepalive 垃圾行、新增思考事件标签 |
| fix | cds | CDS Agent 会话详情改为按 afterSeq 持续重连轮询:CDS stream 端点是一次性(回放缓冲事件+keepalive 后即 Connection:close),运行中会话单次读完即假死,现轮询到终态事件才停 |
| fix | cds | CDS Agent 会话列表 5s 自动刷新改 silent(不再每 5 秒闪 loading 骨架) + loadSessions 加 fetchSeq 守卫(切项目时旧请求晚返回不再覆盖新列表) |
