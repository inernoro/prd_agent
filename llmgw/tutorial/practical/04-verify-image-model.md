# 实战 04：从视觉创作到 Gateway 日志完成验收

最后一篇用真实用户路径证明“应用选逻辑模型，Gateway 选上游”确实发生。测试和正式环境必须分开；先在测试环境完成，正式环境只做发布计划允许的最小请求。

## 免费检查

1. 以有权限的管理员进入视觉创作，打开模型选择器。
2. 确认显示 `image2`、`nanobanana-2` 和已配置的其他逻辑模型，没有 Provider、Endpoint 或模型池成员名称。
3. 切换逻辑模型后刷新页面，确认选择值仍是 PublicId。
4. 以无该功能权限的角色登录，确认默认没有模型网关跳转和受限逻辑模型。

## 最小真实请求

1. 选择 `image2`，输入不含敏感信息的短提示词，只生成一张测试图。
2. 保存 requestId；不要用时间猜是哪条日志。
3. 进入 LLMGW“工作区 → 请求记录”，按完整 requestId 搜索。
4. 列表主标题应显示逻辑模型，次级信息显示实际 Provider 和实际模型。
5. 打开详情“路由”，核对 LogicalModelId、PublicId、OfferingId、实际模型、协议、上游尝试和回退原因；`GatewayTransport` 应为 `http`，`ModelGroupId` 应为空。
6. 若允许一次故障切换测试，让首个假上游失败，再核对同一 PublicId 下第二个 Offering 成功。

## 必须保存的证据

| 证据 | 正确结果 |
|---|---|
| 视觉选择值 | 逻辑模型 PublicId |
| 请求日志 | 同时有 LogicalModelId 和 OfferingId |
| 执行边界 | GatewayTransport 为 http，ModelGroupId 为空 |
| 实际路由 | Provider、实际模型、协议与 Offering 一致 |
| 故障切换 | PublicId 不变，上游尝试增加 |
| 权限 | 未授权 appCaller 不在目录中看到模型 |
| 费用 | unknown 仍显示 unknown，不折算为 0 |

## 回滚检查

- 禁用新逻辑模型即可让新版视觉目录停止展示，不删除旧池。
- 旧调用方没有显式模型时仍能使用默认池。
- 回滚应用版本后，旧模型池、平台、模型和 Exchange 数据仍在。
- 不通过删除 Provider 或清空池来做回滚。

## 看到什么算成功

视觉创作能选择多款逻辑模型；一次真实请求可从 PublicId 追到具体 Offering 和实际上游；故障切换不会改变用户所选逻辑模型；无权限角色和跨租户请求均被服务端拒绝。

## 常见失败

- 所有页面都要求重新登录：先检查 Console 与 MAP 会话入口，不把鉴权问题误判成模型目录问题。
- 视觉创作仍只有一个“模型池”：测试环境没有逻辑模型数据，或页面仍读取旧池投影。
- 日志只有实际模型：日志模型或 API 投影没有贯通 LogicalModelId 与 OfferingId。
- 日志仍是 `inproc` 或带旧 `ModelGroupId`：MAP 只更新了模型列表，执行链没有进入独立 Gateway；逻辑模型请求必须 fail-closed，禁止同名旧池接管。
- 选择一个模型却命中另一个 PublicId：显式模型解析错误，必须停止发布；默认池只允许在没有选择时使用。
