# LLMGW 发布前协议兼容回归

**一句话**：用固定请求重跑指定提交，分别判断协议模拟与真实供应商是否保留调用语义。
**谁该读**：调整网关版本、模型配置、协议适配或发布门禁的工程师。
**读完能做什么**：选择正确回归范围、比较两次结果，并区分通过、拒绝与未验证。

## 能力矩阵与适用范围

“模拟”表示客户端请求穿过生产 serving 端点、LlmGateway 和真实适配器，只有上游 HTTP 是受控响应。它不证明供应商可用或模型能力已经登记。固定语料的两个上游是 OpenAI Chat Completions 与 Claude Messages；Gemini 在这里指兼容入口，不能外推为原生 Google 上游覆盖。

| 入口/能力 | 非流式 | 流式 | 适用范围与边界 |
|---|---|---|---|
| GW Native | 固定 text/tools 请求 | 固定 text/tools 请求 | invoke 与 stream 分开执行；检查真实 HTTP 信封、正文、工具、用量；非流式 DTO 无 finish reason，报告显式标记 inferred，不视为结束原因保真证据 |
| OpenAI Chat compatible | 固定 text/tools 请求 | 固定 text/tools 请求 | 两种上游适配器；流式必须有 finish_reason 和 [DONE]；工具 id、名称与 JSON 参数不允许缺失 |
| Claude compatible | 固定 text/tools 请求 | 固定 text/tools 请求 | 工具转换到 tool_use/input_json_delta；必须有 message_stop；当前流式仅输出 output usage，input/cache 用量尚不保真 |
| Gemini compatible | 固定 text/tools 请求 | 固定 text/tools 请求 | functionDeclarations；ANY + 单个 allowedFunctionNames；functionCall 参数必须完整 JSON 对象；流式分片按索引合并后输出 |
| 原生 Gemini 上游 transformer | 复用 GeminiNativeTransformerTests 的工具/用量固定夹具 | 未新增验证 | 仅证明既有独立转换器的对应字段映射；不在 40 组合 HTTP 回放与真实供应商报告范围，不能以 Gemini 入口回放替代 |
| Responses compatible `/v1/responses` | 复用既有端点测试 | 复用既有工具事件测试 | 这是 Chat 转换路径，未声称完整原生 Responses 保真；不在新 HTTP 语料/跨版本语义比较中 |
| Native Responses `/gw/v1/responses` | 复用真实网关的固定响应测试 | 复用双工具轮次原始 SSE 测试 | 只支持原生 OpenAI Responses；完整输入历史、store:false；上游存储会话引用明确拒绝；不在新 HTTP 语料/跨版本语义比较中 |
| 工具调用 | 名称、id、参数结构、choice 与 schema | 分片重组、结束原因 | 固定单工具；Claude 多轮翻译复用旧测试。并行交错、多模态工具、流式取消没有新增完整组合覆盖 |
| 结束原因 | 适配器/既有测试 | 适配器枚举与四入口正常/tool 终止 | 先按出口校验合法枚举，再对 stop/end_turn、tool_calls/tool_use、FUNCTION_CALL 做语义归一；length/max_tokens、safety/content_filter 在适配器夹具中覆盖，兼容出口可能归一或覆盖，不能宣称全链路保真 |
| 用量 | 固定 input=11、output=7 | 固定计数、OpenAI 末帧 usage 及 Claude 开始/终止分帧合并 | 模拟严格校验值；真实结果校验字段/类型/非负，比较时忽略数值波动；Claude SSE input 缺失是显式债务；cache/reasoning 细项由既有适配器/原生 Responses 测试局部覆盖 |
| HTTP/SSE 错误 | 复用 LlmGateway/Thinking/NativeResponses 错误测试 | SSE 错误不能算成功、截断原生 Responses 不得成功 | 覆盖 400/401/503、网络/超时、原生截断及失败事件；没有对真实供应商人为制造限流/超时 |
| `reasoning_effort` / `reasoning` | 固定请求核对物理字段 | 同一参数核对物理字段 | OpenAI + 模型精确能力声明 + strict-require；Claude 转换尚未实现，固定请求要求 PARAMETER_PROTOCOL_UNSUPPORTED 且零上游调用 |
| IncludeThinking | 复用 ThinkingProtocolContractTests | reasoning_content/reasoning 不混入正文 | OpenRouter 扩展仅向精确 OpenRouter 目标编码；原生 OpenAI 不附带这些扩展；没有以无思考文本推断模型内部未推理 |
| 推理模型预算与采样 | 复用 ReasoningChatBudgetCompatibilityTests | 同左 | o 系列输出预算别名、采样去除、严格策略拒绝与 gpt-5.6 工具 reasoning_effort:none 继续使用已有合同 |
| 不支持/未知参数 | strict-require 显式拒绝 | 同左 | Native/OpenAI 严格策略可证明不静默丢参；旧 Claude/Gemini compatible 默认 default-drop，任意未声明参数没有通用拒绝保证，不能作严格参数保真入口 |

以上覆盖文本 LLM 调用；图片、音视频、embedding 等独立传输能力不纳入本批。没有新增协议适配器、开通服务或购买模型。

## 回归入口

依赖 .NET 8 与 Python 3 标准库。先在目标 checkout 构建，再运行：

```bash
dotnet restore prd-api/PrdAgent.sln
dotnet build prd-api/PrdAgent.sln --no-restore
bash scripts/llmgw-compat-regression.sh work/compat-v1
```

每次使用新的输出目录。入口运行既有协议夹具、严格参数/错误/Responses 测试以及 40 个四入口组合回放；输出独立 TRX、synthetic captures 和 simulation.json。捕获中携带生产 serving 程序集的构建提交，必须与指定提交匹配。构建失败、测试失败、旧二进制、缺捕获、语义不符均非零退出；不会读旧捕获兜底。

同一语料重复执行或比较另一提交：

```bash
python3 scripts/llmgw-compat-regression.py --mode simulation \
  --captures work/compat-v2/captures --expected-commit "$(git rev-parse HEAD)" \
  --baseline work/compat-v1/simulation.json --output work/compare.json
```

比较检查语料哈希、用例集合、证据类型、固定应答正文、工具名/JSON 参数、报告模型、结束语义和用量字段。本批文本请求明确要求回复 `OK`，只忽略首尾空白；错误正文必须失败，报告保留实际确认应答。生成 id、时间戳及真实 token 数不做逐字比较；工具参数仍精确比较。这只证明固定确认应答的语义，不外推为一般自然语言任务质量。

## 真实供应商验证

只使用已经配置的测试网关、模型和权限。先复制 `scripts/fixtures/llmgw-compat/target.example.json` 到受控位置，填测试地址、固定模型、已授权且团队归属匹配的 `appCallerCode` 和已确认支持的 caseIds。模型需有相应工具/参数能力声明。`appCallerCode` 同时替换 Native 请求体和四入口请求头，并记入比较目标合同；不填时兼容旧默认 `report-agent.generate::chat`，不能用 headersEnv 单独覆盖成另一个身份。业务消息、工具 schema 和参数断言保持同一固定语料。keyEnv 和 headersEnv 仅引用环境变量名；密钥、任务许可等从安全渠道注入，不能写进文件或提交。

```bash
python3 scripts/llmgw-compat-regression.py --mode provider \
  --target work/provider-target.json --expected-commit <完整40位部署提交> \
  --output work/provider-v1.json
```

执行前 healthz 必须返回该完整提交。每个所选用例最多调用一次，无自动重试或替身回退；默认示例 16 个用例，未选择的推理参数用例逐项列入 unverified。健康检查不能替代真实请求。CI 报告保留状态、媒体类型、字节数、响应哈希和安全的语义结果；详细原文应在网关受控审计中查询，不能上传任意供应商响应原文。模拟 captures 仅包含合成数据。

失败报告另保留有界的结构化 `errorCode`，不保存任意供应商错误正文。`PARAMETER_UNVERIFIED` 表示当前模型缺少精确参数能力确认，不能解释为请求成功或自动改成 default-drop。尤其 gpt-5.6 的既有 Chat 兼容处理会在关闭思考时使用 `reasoning_effort:none`；严格入口仍要求对应参数能力确认。Claude/Gemini compatible 默认丢参路径能调用成功，不代表同一模型的严格入口或推理参数也已验证。

CI 的 `LLMGW_COMPAT_TARGET` secret 保存目标 JSON，引用 `LLMGW_COMPAT_KEY` / 可选 `LLMGW_COMPAT_HEADERS`。手动 dispatch 现有 CI 时打开 llmgw_provider，并填写 llmgw_expected_commit。provider job 不依赖 simulation、失败照样上传独立 provider.json，并使 CI Status 失败。未打开时 job 为 skipped，表示未验证；未配置凭据却打开验证时直接失败。常规 PR 自动执行模拟回归，不自动消费供应商额度。

## 探测有效性与未验证项

Python 回归包含删除 finish_reason、tool id/name/arguments、用量和终止帧的故障探测；任何一次必须被拒绝。固定应答被改成错误内容，以及成功正文冒充“不支持参数”错误，都必须失败；拒绝必须有结构化错误码与失败信封。新 Gemini 固定工具请求包含两段中文 JSON 参数，可直接发现“普通聊天正常，流式工具参数损坏”。

真实验证必须按当次预览版本、项目凭据的实际作用域与任务许可执行。项目存在网关密钥配置，不等于当前调用已获准；AI_ACCESS_KEY 也不是网关调用凭据的替代。未触达真实供应商时只可标为未验收，不能将 simulation 通过当成 provider 通过。原生 Responses 真实配对、旧 compatible 默认丢参边界、全部终止/用量细项的出口保真仍见[协议保真债务](../../doc/debt.platform.llm-gateway.protocol-fidelity.md)。后续由网关维护者用已有模型完成同一部署版本的 provider 报告后，才能对所选范围签署真实兼容结论。


## 隔离旧行为与修复后行为的证明

不能用修改捕获文件代替旧生产代码的反向验证。以下入口把同一套客户端请求与断言冻结到临时目录，将旧提交的生产代码在隔离 Git worktree 中编译，再执行当前提交。只在旧版的代表性用例真实失败、修复版通过时，证明报告才为 pass；编译失败、缺失捕获或版本不符均不算有效的红灯。不会改动运行环境。

```bash
python3 scripts/llmgw-compat-red-green.py --old-ref <旧提交完整SHA> --output work/red-green-new
```

输出保留两边的版本、固定测试文件哈希、TRX、捕获、语义失败项与 proof.json；退出时移除自己创建的隔离源码工作树。旧代码应至少触发 Gemini 工具参数分片、跨协议结束枚举和 Claude 分帧输入用量三条失败。若旧提交已具备修复，脚本会拒绝把它当成反向证明。

验收证据必须区分：确定性夹具证明协议转换与检查器的区分能力；预览健康检查仅证明对应版本可达；真实供应商路径仍须独立的合法调用与审计证据。CLI 工具没有新增页面，主题与移动端布局不适用于此入口；不能用旁边控制台页面的截图替代调用结果。
