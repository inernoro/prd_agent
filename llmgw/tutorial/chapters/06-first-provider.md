# 第 6 章 配置第一个 Provider

## 你在做什么

你将创建“教程假上游”Provider，保存接口类型、API 地址、通讯密钥和最大并发。它只用于教程隔离环境，不产生真实模型费用。

## 为什么要做

Provider 告诉 Gateway“去哪里以及怎样连接上游”。Provider 通讯密钥由 Gateway 使用，业务应用不能拿它调用 Gateway；业务应用稍后使用的是 `gwk_` 租户接入密钥。把两者分开，才能独立轮换、审计和撤销。

## 开始前检查

- 当前租户仍是“教程咖啡店”，角色为 Owner 或 Admin。
- 使用平台自带的公开测试桩：API 地址是 `https://map.ebcone.net/api/v1/stub`，供应方标识是 `stub`。它只返回固定测试结果，不调用付费模型。
- 地址不得包含用户名、密码、密钥查询参数或私网绕过写法；教程不使用生产 Provider。

## 跟我做

> 每做完一个编号步骤，就核对紧接在步骤下方的圈选图。同一步有两张图时，第一张确认入口或全貌，第二张确认字段或结果。

1. 在左侧“路由”下点击“Provider”。

**图 021 从左侧导航点击“Provider”，不用猜页面地址**

![图 021 从左侧导航点击“Provider”，不用猜页面地址](https://cds.miduo.org/api/reports/assets/749ddb40bb1b54fe3a2bf85905e883616d16b632026f2a950f664646a2e831fb.png)

2. 阅读页面顶部说明，点击“添加 Provider”。

**图 022 Provider 页面先展示现有上游、密钥状态和启用状态**

![图 022 Provider 页面先展示现有上游、密钥状态和启用状态](https://cds.miduo.org/api/reports/assets/13f515d774ee763715bc75b3821109cf4cfaff4affb168a33b21d33b22a52812.png)

3. 名称填写“教程假上游”，接口类型选择“OpenAI 兼容”。

**图 023 点击“添加 Provider”开始配置第一个上游**

![图 023 点击“添加 Provider”开始配置第一个上游](https://cds.miduo.org/api/reports/assets/74834fac71b3d5c98b9f80035e040967649cfadde799221853100a6a7507a54b.png)

4. API 地址填写 `https://map.ebcone.net/api/v1/stub`。通讯密钥字段填写固定测试标记 `tutorial-stub-only`；它不是生产秘密，只用于满足 Provider 字段合同。

**图 024 Provider 表单把名称、协议、地址、凭据和并发放在一起**

![图 024 Provider 表单把名称、协议、地址、凭据和并发放在一起](https://cds.miduo.org/api/reports/assets/ba08e39934a1e467d916f734bd8e475d7aa2d05ece442e40787fcca05215f299.png)

5. 最大并发保持 20；供应方标识填写 `stub`，备注写“教程隔离测试”。`stub` 标识让系统按测试桩规则处理这条配置。

**图 025 上游地址字段填写供应商地址，不填写 Gateway 自己的地址**

![图 025 上游地址字段填写供应商地址，不填写 Gateway 自己的地址](https://cds.miduo.org/api/reports/assets/71fed205a2502d91c30f9e2cebd991f605bad5e0a5c92f4d3f3ad735f881dfb7.png)

6. 点击“保存并继续添加模型”。保存期间不要重复点击。

**图 026 上游 key 只在保存表单输入，列表只显示已配置**

![图 026 上游 key 只在保存表单输入，列表只显示已配置](https://cds.miduo.org/api/reports/assets/5d9ee2bd282d8d4d31205e8a26a89588de47b98e75313cce84a92b41eff2fe66.png)

7. 在列表核对名称、类型、API URL、启用状态和密钥“已配置”。列表不应回显密钥明文。

**本步位置复核：在同一圈选画面完成本步后再继续。**

![图 026 上游 key 只在保存表单输入，列表只显示已配置](https://cds.miduo.org/api/reports/assets/5d9ee2bd282d8d4d31205e8a26a89588de47b98e75313cce84a92b41eff2fe66.png)

## 看到什么算成功

页面提示 Provider 已保存、通讯密钥已加密并可继续添加模型。列表出现“教程假上游”，状态为启用，密钥列只显示“已配置”。刷新页面后记录仍在，但任何位置都没有真实通讯密钥。

## 失败怎么办

- 提示 URL 无效或目标不安全：逐字核对本章地址，去掉用户信息和查询参数；不要改用内网地址或关闭保护。
- 模型列表无法读取：在浏览器打开 `https://map.ebcone.net/api/v1/stub/v1/models`，应看到 `stub-chat` 与 `stub-vision`；不是 200 时先停止本章并报告测试桩故障。
- 保存后密钥显示未配置：停止下一步，重新打开添加流程或由管理员检查加密配置；不要在日志中粘贴密钥。
- 当前角色只能查看：Owner 或 Admin 才能创建 Provider，让管理员完成后你再继续。

## 本章小结

“教程假上游”现在是 Gateway 的上游连接。业务应用还不能调用，因为具体模型、模型池、appCaller 和接入密钥尚未建立。

## 下一章

点击 [[第 7 章：配置第一个模型]]，在这个 Provider 下添加“教程聊天模型”和“教程视觉模型”。
