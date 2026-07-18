# Page Agent Bridge 设计（编码 Agent 浏览器之眼） · 设计

> **版本**：v2.0 | **日期**：2026-07-17 | **状态**：已落地

## 一、管理摘要

- **解决什么问题**：编码 Agent 部署页面后，需要读取真实浏览器 DOM、控制台和网络状态，并在用户可见范围内执行验证操作。
- **当前方案**：CDS Widget 在预览页收集受控页面状态，通过 Bridge Service 的 HTTP 轮询接收命令并回传结果。
- **授权边界**：Bridge 默认关闭或休眠；需要用户打开预览页，并可通过 handshake 明确批准 Agent 会话。
- **可见性原则**：点击、输入和导航必须有轨迹、目标高亮和操作说明，不能进行用户看不见的浏览器控制。

## 1. 参与者与所有权

| 参与者 | 责任 |
|--------|------|
| 编码 Agent | 请求会话、读取状态、下发受控命令、解释结果 |
| CDS Bridge Service | 管理连接、队列、超时、审批和结果关联 |
| CDS Widget | 在浏览器提取状态、展示审批和执行命令 |
| 用户 | 打开目标页面、批准会话、观察并可结束操作 |

Agent 不能仅靠服务端自行创建真实浏览器上下文。没有已打开并连接的 Widget 时，Bridge 返回未连接或等待用户，不能伪造页面状态。

## 2. 会话生命周期

1. Widget 以低频检查确认当前分支是否有激活请求。
2. Agent 发起 handshake 或 session 请求，服务端绑定 branch ID。
3. Widget 展示请求原因，用户批准或拒绝。
4. 批准后 Widget 开始 heartbeat，上报页面状态并领取命令。
5. Agent 逐条发送命令，等待关联结果后再决定下一步。
6. 用户、Agent、超时或页面离开可以结束会话。
7. 服务端清理待处理命令与结果等待者，Widget 返回休眠。

连接 heartbeat 超时后标记断开。旧命令不能在新会话中继续执行。

## 3. 页面状态

Widget 上报受控摘要而非完整 DOM 镜像，包括当前 URL、标题、视口、可交互元素、主要文本、控制台错误、网络错误、焦点和滚动位置。

状态限制大小，过滤密码、token、隐藏输入和敏感 DOM。Agent 不能通过 evaluate 绕过过滤读取任意浏览器存储。

## 4. 命令契约

| 命令 | 用途 | 约束 |
|------|------|------|
| snapshot | 重新读取页面状态 | 只返回受控摘要 |
| click | 点击当前快照中的交互元素 | 使用索引并验证元素仍有效 |
| type | 向允许的输入控件写入文本 | 禁止密码和敏感字段自动填充 |
| scroll | 滚动页面或目标区域 | 结果回报新位置 |
| spa-navigate | 触发应用内路由 | 通过统一 Bridge 导航事件 |
| navigate | 请求完整页面导航 | 外部地址需要用户确认 |
| evaluate | 受限诊断表达式 | 默认关闭或严格白名单 |

每条命令包含 ID、action、参数、description 和超时。`description` 是用户可见的操作说明，不能为空。

## 5. 操作可视化

- 点击前移动可见光标到目标并高亮。
- 输入前显示目标字段和操作说明，不展示敏感文本。
- SPA 导航通过 `bridge:navigate` 事件交给应用路由处理。
- 完整导航展示目标地址和原因，并按策略要求用户确认。
- 操作面板持续显示 pending、running、done 或 error。
- reduced motion 开启时减少轨迹动画，但保留文字反馈。

视觉动画不能替代结果校验。点击成功只表示事件已触发，Agent 仍需读取下一快照确认页面变化。

## 6. 队列、超时与并发

Bridge 按 branch 隔离连接和命令队列。一个命令只交付一次，并通过命令 ID 关联结果。等待超时后从队列移除，迟到结果不得满足后续命令。

同一分支默认只有一个受控活动会话。并发 Agent 请求需要排队或明确拒绝，不能交错操作同一页面。连接、handshake、导航请求和命令都设置 TTL。

## 7. 安全边界

- Bridge 由 `CDS_BRIDGE_ENABLED` 或等价服务端配置开启。
- 所有 Agent 端点要求 CDS 鉴权，并校验目标分支访问权。
- Widget 内部端点只接受有效 branch 和会话上下文。
- 命令参数限制大小、协议、目标地址和动作类型。
- 页面状态过滤凭据、Cookie、localStorage 和敏感输入。
- 所有会话、批准、命令和结果写入受控活动日志。
- 用户可以随时结束会话，结束后 Agent 不再发送命令。

## 8. 当前事实入口

| 能力 | 事实入口 |
|------|----------|
| 会话和命令队列 | `cds/src/services/bridge.ts` |
| HTTP 路由与鉴权 | `cds/src/routes/bridge.ts` |
| 浏览器 Widget | `cds/src/widget-script.ts` |
| 分支详情入口 | `cds/web/src/pages/BranchDetailPage.tsx` |
| 路由测试 | `cds/tests/routes/bridge-disabled.test.ts` |
| Widget 契约测试 | `cds/tests/services/widget-script-bridge.test.ts` |

## 9. 验收标准

- Bridge 关闭时所有控制入口拒绝执行。
- 未打开 Widget 或未批准时 Agent 无法操作页面。
- 命令、结果和状态严格按 branch 与 session 隔离。
- 点击、输入和导航均有用户可见说明和反馈。
- 连接超时、用户结束和页面离开会清理命令队列。
- 页面状态不泄露密码、token 和浏览器私有存储。

## 关联文档

- `doc/rule.platform.bridge-ops.md`
- `doc/guide.cds.agent.workbench.md`
- `doc/design.cds.md`
