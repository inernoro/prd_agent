# Skill: 自动化测试与调试

> 触发词：`自动测试`、`端到端测试`、`E2E 测试`、`集成测试`、`真实请求调试`、`用浏览器验证`、`验证修复`

## 概述

通过真实 API 调用 + 日志分析的方式，自动化验证功能并定位问题。核心思路：**不靠猜测，靠证据**。

## 核心原则

1. **先观察再修改**：通过真实调用获取实际行为，而非假设
2. **日志驱动定位**：查看请求日志、响应内容、错误信息定位问题
3. **迭代验证**：修复 -> 编译 -> 重启 -> 验证 -> 再修复
4. **最小化变更**：每次只改一处，确认效果后再改下一处

## 通用流程

### 阶段 1：确定测试目标

- 明确要测试的功能/接口
- 确定预期结果是什么
- 准备测试数据（如有需要）

### 阶段 2：环境就绪检查

```bash
# 检查服务是否运行 (跨平台 curl)
curl -s --max-time 5 "{BASE_URL}/health"

# 检查依赖配置（如模型池、数据库记录等）
# 根据具体功能确定需要检查什么
```

### 阶段 3：执行测试调用

```bash
# 使用 curl 发起请求 (Linux/Mac/Windows 通用)
curl -X POST "{ENDPOINT}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {TOKEN}" \
  -d '{
    "field1": "value1",
    "field2": "value2"
  }'

# 如需格式化输出，可配合 jq (需安装)
curl -s ... | jq .

# 保存响应到文件
curl -s ... -o response.json
```

**Windows PowerShell 替代写法**：
```powershell
$response = Invoke-RestMethod -Uri "{ENDPOINT}" -Method Post `
  -Headers @{"Content-Type"="application/json"} `
  -Body '{"field1":"value1"}'
$response | ConvertTo-Json -Depth 5
```

### 阶段 4：收集诊断信息

**HTTP 错误时**：
- 记录 HTTP 状态码：`curl -s -w "\nHTTP: %{http_code}" ...`
- 读取响应体中的错误信息
- 检查服务端日志/控制台输出

**业务错误时**：
- 检查 error.code 和 error.message
- 查询相关日志（如 LLM 调用日志）
- 追踪调用链路

**异常堆栈时**：
- 定位异常发生的代码位置（文件:行号）
- 理解异常类型和消息
- 分析上下文变量状态

### 阶段 5：问题定位

| 现象 | 可能原因 | 排查方向 |
|------|----------|----------|
| 500 Internal Error | 未处理的异常 | 查看服务端控制台的堆栈 |
| 502 Bad Gateway | 上游服务调用失败 | 检查 LLM/外部服务日志 |
| 400 Bad Request | 请求参数错误 | 检查请求体格式、必填字段 |
| 数据不符预期 | 业务逻辑问题 | 断点调试或添加日志 |
| 调用未发生 | 前置条件未满足 | 检查配置、权限、条件判断 |

### 阶段 6：修复与验证

```bash
# 1. 修改代码
# 2. 编译
dotnet build {PROJECT}.csproj -v q      # .NET
npm run build                            # Node.js
cargo build                              # Rust

# 3. 提示用户重启服务
# 4. 重复阶段 3-5 直到成功
```

## LLM 调用场景的特殊处理

当功能涉及 LLM 调用时，**必须检查 LLM 日志**：

```bash
# 获取最近的 LLM 调用记录
curl -s "{BASE_URL}/api/logs/llm?limit=10" \
  -H "X-AI-Access-Key: {KEY}" \
  -H "X-AI-Impersonate: admin" | jq '.data.items[] | {
    purpose: .requestPurpose,
    model: .model,
    status: .status,
    error: .error,
    duration: .durationMs
  }'
```

**关键检查项**：
- `requestPurpose`：确认是目标功能发起的调用
- `status`：succeeded / failed
- `requestBody`：请求体是否完整（关键字段是否存在）
- `error`：具体错误信息

**常见 LLM 调用问题**：

| 问题 | 日志特征 | 修复方向 |
|------|----------|----------|
| 调用未发生 | 无对应 purpose 的记录 | 检查代码是否执行到调用处 |
| 请求数据丢失 | requestBody 缺少关键字段 | 检查序列化逻辑 |
| 模型无响应 | status=failed, TIMEOUT | 增加超时或换模型 |
| 上游服务问题 | HTTP 5xx | 等待恢复或换模型池 |
| 响应不符预期 | status=succeeded 但结果错 | 调整 Prompt 或换模型 |

## 多步骤链路调试

当功能包含多个步骤时（如 A -> B -> C）：

1. **确认每步是否执行**：检查日志中是否有各步骤的记录
2. **检查步骤间数据传递**：前一步的输出是否正确传给下一步
3. **定位首个失败点**：从第一个失败的步骤开始排查

## 浏览器辅助调试

当需要通过 UI 交互测试时，可使用 MCP browser 工具：

1. `browser_navigate` - 打开目标页面
2. `browser_snapshot` - 获取页面状态
3. `browser_click` / `browser_type` - 模拟操作
4. 配合 API 日志验证后端行为

## 输出规范

测试过程中应输出：
- 请求内容（脱敏后）
- 响应内容或错误信息
- 关键日志摘要
- 问题定位结论
- 修复方案（如需要）

## 迭代模式

```
发现问题 -> 定位原因 -> 修复代码 -> 编译 -> 重启 -> 验证 -> (循环直到成功)
```

每次迭代：
- 只改一处，验证一处
- 记录每次修改的内容
- 如果修复无效，回滚并尝试其他方案

## 平台特定命令参考

| 操作 | Linux/Mac | Windows PowerShell |
|------|-----------|-------------------|
| HTTP GET | `curl -s URL` | `Invoke-RestMethod URL` |
| HTTP POST | `curl -X POST -d 'data' URL` | `Invoke-RestMethod -Method Post -Body 'data' URL` |
| JSON 格式化 | `jq .` | `ConvertTo-Json -Depth 5` |
| 查看文件尾部 | `tail -f file.log` | `Get-Content file.log -Wait` |
| 环境变量 | `export VAR=value` | `$env:VAR="value"` |

## 注意事项

- 不要猜测问题原因，用日志和实际响应作为证据
- 遇到上游服务问题（如 503），先确认是否为临时问题
- 复杂问题可以创建备忘录（memo）记录进度，便于后续继续
- 优先使用 curl，跨平台兼容性最好
