| feat | prd-api | LLM Gateway appCaller 被动注册累计 ObservedIngressProtocols，支持同一 appCaller 被多入口协议复用 |
| feat | prd-llmgw | appCaller 列表和协议覆盖矩阵基于 ObservedIngressProtocols 判断注册证据，并兼容旧 IngressProtocol 单值 |
| polish | prd-llmgw-web | appCaller 控制台入口列展示已观察到的协议列表，避免被最后一次入口覆盖误导 |
| test | prd-api | 增加 ModelLab/Arena pinned 经 GW 调用的防退化守卫 |
| feat | prd-llmgw | runtime gates 增加 appCaller 入口协议注册覆盖阻塞项，防止只看日志忽略注册表证据 |
| polish | prd-llmgw-web | 概览页 runtime gate 为 appCaller 入口协议注册覆盖提供协议覆盖和调用方深链 |
| test | scripts | release gate 自测覆盖 appCaller 入口协议注册 gate，protocol canary 文案同步说明注册表证据 |
| test | prd-api | 增加模型池协议优先级防退化测试，守卫池条目 Protocol 优先于模型和平台 |
| docs | doc | 更新 LLM Gateway 协议绑平台债务状态，区分已守卫文本解析链与剩余图片/raw 分支 |
| fix | prd-api | 生图 adapter 选择改为优先使用 Gateway 解析出的 Protocol，避免同平台多协议被 URL 或模型名猜回旧适配器 |
| test | prd-api | 增加生图 adapter 显式协议覆盖 URL/模型名检测的防退化测试 |
| fix | prd-api | Agent runtime profile 从模型池导入时优先使用模型 Protocol，避免按平台类型或 URL 误判运行协议 |
| test | prd-api | 增加 runtime profile 协议解析防退化测试，守卫模型 Protocol 覆盖平台和 URL 推断 |
| fix | prd-api | ASR chat-audio 路由改为优先依据 Gateway 解析出的 Protocol，避免同平台多协议被 PlatformType 误分流 |
| test | prd-api | 增加 ASR chat-audio 路由策略测试，覆盖协议优先和旧平台兜底 |
| fix | prd-api | Gateway adapter 选择支持协议别名映射，避免 anthropic/claude-compatible 被误落到 OpenAI 兜底 |
| test | prd-api | 增加 Gateway adapter 协议别名映射防退化测试 |
