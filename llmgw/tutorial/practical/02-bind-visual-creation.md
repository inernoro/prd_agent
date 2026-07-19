# 实战 02：让视觉创作显示多款图片模型

模型已经创建，但视觉创作仍只显示一款，通常不是前端缓存问题，而是 appCaller、模型池和成员没有连成有效链路。本实战用 `visual-agent.image.text2img::generation` 说明如何补齐绑定。

## 先理解四层关系

1. Provider 回答“请求发到哪里、用哪把上游密钥”。
2. 模型回答“上游调用什么标识、具备什么用途”。
3. 模型池回答“这类业务可以从哪些模型中选择”。
4. appCaller 回答“哪个业务使用哪个池”。

任意一层缺失，视觉创作都可能只显示默认桩、显示旧模型，或运行时选不到新模型。

## 跟我做

1. 进入“路由 → 模型池”，找到类型为“图片生成”的 generation 池。
2. 希望多款模型同时供用户选择时，优先维护一个明确的视觉创作专用池；不要把每款模型都建成互不关联的单成员池。
3. 打开“查看与维护”，在候选模型中选择 `gpt-image-2-all`，点击“添加/更新”或“追加模型”。
4. 确认原有成员仍保留，新成员只出现一次。主推模型可设优先级 1，备选模型依次使用 2、3。

![模型池详情先展示用途、默认状态和绑定 appCaller](https://cds.miduo.org/api/reports/assets/a89b7e254589e474e9d02c095af54f917f409a18ac7afb709c4653cd6651a5e7.png)

5. 进入“路由 → appCaller”，搜索 `visual-agent.image.text2img::generation`。
6. 如果状态是 `discovered`，先把它治理为 active；请求类型必须是 generation。
7. 在“配置路由与治理”中选择刚才维护的 generation 池并保存。
8. 同样检查视觉创作实际使用的其他 generation 调用方，例如图片编辑、批量生图或画板生图。只绑定真实使用的调用方，不要把所有 generation appCaller 一次性改到同一池。
9. 回到视觉创作页面刷新模型选择器，确认新增模型出现。

![appCaller 关联预览能核对模型池类型、候选模型和最近运行](https://cds.miduo.org/api/reports/assets/d6ed02a5558eb0f45a49ec2b0f0b3dba729f2aa9b404ce7beff44a7901ce16ad.png)

## 测试环境的典型错误

- 已有 `gpt-image-2-all` 单成员池，但它引用的 Provider 已不存在。
- generation 默认池仍只有 `stub-image`。
- `visual-agent.image.text2img::generation` 仍处于 discovered，`modelPoolId` 为空。

这三种情况同时出现时，新建更多同名池不会解决问题。应先恢复权威 Provider 和模型，再把模型纳入有效 generation 池，最后治理并绑定 appCaller。

## 看到什么算成功

- 视觉创作模型选择器至少出现原模型与 `gpt-image-2-all` 两款启用模型。
- appCaller 状态为 active，请求类型为 generation，绑定池也属于 generation。
- 池成员引用的 Provider 均存在且启用，没有孤立旧 platformId。
- 用户明确选择某款模型后，期望模型与实际模型可以解释；发生回退时有原因。

## 常见失败

- appCaller 不能设为 active：所选池不存在、类型不匹配或没有可解析成员。
- 候选列表找不到模型：模型未启用，或没有声明“图片生成”用途。
- 列表出现模型但调用失败：继续做实战 04，从 requestId 检查实际 Provider、协议和上游错误。
- 只有管理员看得到配置：这是权限设计。Viewer 和普通成员不应拥有路由写权限，但业务页面仍可展示租户允许使用的模型。

## 回滚

记录变更前的 appCaller 池 ID。回滚时重新绑定原池或恢复原路由方式；保留新模型为停用状态便于排查。不要通过删除整池完成回滚。
