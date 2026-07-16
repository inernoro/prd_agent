# 第 30 章 常见故障逐步排查

## 你在做什么

这一章建立一条固定排查路线：先保存 requestId 和时间，再看状态码，最后沿 key、appCaller、模型池、模型、Provider、Exchange 逐层定位。你不会一上来就换模型或重置密码。

## 为什么要做

同样是“不能用”，原因可能是没有 key、权限不足、对象不存在、版本冲突、限流、上游错误或费用证据缺失。固定顺序可以减少来回试错，也避免为了修一个问题破坏生产配置。

## 开始前检查

- 复制完整 requestId、发生时间、当前租户和 appCaller；不要复制 key 明文。
- 先用 Quickstart dry-run 判断 Gateway 地址、鉴权和协议形状；需要非 dry-run 证据时只复用第 20 章公开教程桩的一次性安全命令。
- 不批量调用付费模型，不修改共享池，不重置无关账号密码。

## 跟我做

> 每做完一个编号步骤，就核对紧接在步骤下方的圈选图。同一步有两张图时，第一张确认入口或全貌，第二张确认字段或结果。

1. 遇到 401，检查是否确实提供 tenant-scoped service key、是否撤销或过期、Gateway 地址是否来自当前页面。无 key 本来就必须失败。

**图 075 请求详情用 requestId 串起路由、策略、费用和上游尝试**

![图 075 请求详情用 requestId 串起路由、策略、费用和上游尝试](https://cds.miduo.org/api/reports/assets/c559463c5a6e0df620dda4560687de11cbbe0821170450ecb8ab0a116a561dd4.png)

2. 遇到 403，核对角色、团队 scope、appCaller 和协议范围。隐藏按钮只是体验，服务端拒绝才是最终边界。

**图 081 供应商只有时间窗账单时标为汇总，不伪装单条 requestId**

![图 081 供应商只有时间窗账单时标为汇总，不伪装单条 requestId](https://cds.miduo.org/api/reports/assets/976011a35fdab42f768b1625fd237185994acf4c7131f00f39633d46134c6689.png)

3. 遇到 404，确认当前租户和对象 id。跨租户猜测也应返回不存在，不要通过传 tenantId 绕过。

**图 088 展开后只展示带 TenantId 的变更摘要和安全元数据**

![图 088 展开后只展示带 TenantId 的变更摘要和安全元数据](https://cds.miduo.org/api/reports/assets/eeb962e7ae42a3db155110a8779108786682bf5cf10d017021e4e2a8f7c95a7a.png)

4. 遇到 409，重新读取最新版本再合并修改。常见于 Exchange 或 PromptPolicy 并发编辑，不能直接覆盖别人新版本。

**图 097 学习中心先用三步讲清第一条请求，不要求先懂全部术语**

![图 097 学习中心先用三步讲清第一条请求，不要求先懂全部术语](https://cds.miduo.org/api/reports/assets/5b663dc659eb61f03554e6147a1f6b08de72fde553f14100520a9785236155e6.png)

5. 遇到 429，按 ServiceKeyId、appCaller 和团队检查速率与预算，排除客户端重试风暴后再申请调整。

**图 098 完整链路把租户、key、appCaller、池、模型和 Provider 连起来**

![图 098 完整链路把租户、key、appCaller、池、模型和 Provider 连起来](https://cds.miduo.org/api/reports/assets/ddac98c28e33de05568b35661348a0d8f75883d77179341e2a756a113d44a3d7.png)

6. 遇到 5xx 或超时，查看请求详情中的模型池、实际模型、Provider 和 Exchange，再检查第 6 章公开教程桩地址是否能打开模型列表。官方桩没有失败开关，不要改坏它制造错误；502 还需由运维核对代理上游和目标服务。

**图 099 术语索引可以直接跳到对应解释和操作入口**

![图 099 术语索引可以直接跳到对应解释和操作入口](https://cds.miduo.org/api/reports/assets/b0688567037291c40d696a6fe3776dee9353cf57821b8cfd6f76ba5970b09b33.png)

7. 遇到 unknown cost，核对请求价格快照、模型价格与币种。未知不是调用失败，也绝不能改成 0。

**图 100 排错入口要求拿 requestId 定位，不让用户只说“调用失败”**

![图 100 排错入口要求拿 requestId 定位，不让用户只说“调用失败”](https://cds.miduo.org/api/reports/assets/aa7b3bdf62d175bdfb8ecd5e46123481257154f1365173fa3fef87ffbfe14b9e.png)

8. 每次只改变一个因素，再用一条安全请求验证。修复后保留新的 requestId 与旧证据对照。

![图 100 排错入口要求拿 requestId 定位，不让用户只说“调用失败”](https://cds.miduo.org/api/reports/assets/aa7b3bdf62d175bdfb8ecd5e46123481257154f1365173fa3fef87ffbfe14b9e.png)

## 看图核对

无密钥时先停在红框提示，不要通过扩大 scope、复用其他平台 key 或重置控制台密码来绕过。

![红框提示 Exchange 缺少通讯密钥时必须拒绝保存](https://md-private-1251304948.cos.ap-guangzhou.myqcloud.com/data/cds/img/reyipw3mxpdjb6ikxic4fxasre.png)

## 看到什么算成功

每个故障都有明确层级和证据：401 到 key，403 到权限，404 到租户内对象，409 到版本，429 到限流或预算，5xx 到路由或上游，unknown 到价格证据。修复只改变必要配置，回归请求留下新 requestId。

## 失败怎么办

- 没有 requestId：先查代理或客户端是否在进入 Gateway 前失败；不要假设请求已经到达服务端。
- 更换模型后仍失败：退回固定链路检查 appCaller、池、Provider 和 Exchange，不要连续随机换模型。
- 只有生产复现：普通用户停止变更并交给验收人员。验收人员可在隔离环境运行 `dotnet test prd-api/PrdAgent.sln --no-restore --filter "FullyQualifiedName~CrossProcessServingErrorLoadTests"`，用仓库既有失败桩复现传输错误；不要直接改生产共享配置。
- 处理 401 时有人要求重置管理员密码：拒绝无关操作，key 鉴权与控制台密码是不同链路。
- 修复后旧错误仍显示：核对时间、requestId 和页面缓存，不能把旧记录当新失败。

## 本章小结

排错最有价值的习惯是先保留证据、再按层级排查、一次只改一件事。这样既快，也不会让临时尝试变成新的事故。

## 下一章

点击 [[第 31 章：生产接入与回滚清单]]，把测试通过的接入安全地切换到正式 key。
