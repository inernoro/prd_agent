# 第 14 章 理解 key、appCaller 和模型池

## 你在做什么

你将沿着第一条请求反查三个对象：客服组 test key、`tutorial.gateway-book::chat` appCaller 和默认对话池，确认它们分别回答“谁调用”“为什么调用”“去哪里调用”。

## 为什么要做

三个对象都能影响请求，但生命周期不同。key 泄露时只需撤销调用身份；业务用途变化时改 appCaller 治理；模型不健康时调整模型池。若把三者绑成一个对象，轮换密钥可能意外改变路由，替换模型又可能让所有接入方重新发 key。

## 开始前检查

- [[第 13 章：找到第一条请求|第 13 章]]的请求详情仍可打开。
- appCaller 注册表中有 chat 项，默认对话池中有教程聊天模型。
- 接入密钥列表只显示前缀与 key id，不显示明文。

## 跟我做

> 每做完一个编号步骤，就核对紧接在步骤下方的圈选图。同一步有两张图时，第一张确认入口或全貌，第二张确认字段或结果。

1. 从请求详情记下 ServiceKeyId，打开“开发者”下的“接入密钥”，找到对应行。看 client、test 环境、客服组、appCaller、协议和 scope。

**图 054 接入密钥列表按接入方、环境、appCaller、协议、速率和有效期展示**

![图 054 接入密钥列表按接入方、环境、appCaller、协议、速率和有效期展示](https://cds.miduo.org/api/reports/assets/6dc1f580e61d83fd7e0f70131b4b18e229a7c2235852814bfead14493c65a6aa.png)

**图 014 单个接入方的速率与撤销也在接入密钥管理**

![图 014 单个接入方的速率与撤销也在接入密钥管理](https://cds.miduo.org/api/reports/assets/394491eb2ee240f07aa006741c2591f53961609b4b90b8ec23bd69eff8e7f7eb.png)

2. 打开“工作区”下的“appCaller”，搜索 `tutorial.gateway-book::chat`。看它的业务标题、请求类型、团队和 `auto` 路由方式。

**图 043 appCallerCode 是业务用途身份，OpenRouter App 显示为 G-加 appCallerCode**

![图 043 appCallerCode 是业务用途身份，OpenRouter App 显示为 G-加 appCallerCode](https://cds.miduo.org/api/reports/assets/7483f209d1fe7d83dbe4e41ddb7b0760ac817ad7a560795c77b3db8900d7305b.png)

3. `auto` 没有专属模型池链接。单独打开“路由”下的“模型池”，找到默认对话池，理解 chat 用途会从这里选择候选成员；这次 dry-run 在模型解析前结束，不能拿它证明实际命中了某个池。

**图 038 模型成员逐项展示健康、优先级、协议、能力和价格币种**

![图 038 模型成员逐项展示健康、优先级、协议、能力和价格币种](https://cds.miduo.org/api/reports/assets/2016514decea89d72156a671c2e6eb283c4e1863ee99cbea009d6d400fa9017a.png)

4. 做一次口头演练：如果 key 泄露，撤销 key；如果客服改为新业务用途，新建 appCaller；如果教程聊天模型不可用，模型池按规则选其他兼容成员。

**图 046 模型池字段决定这项业务从哪个候选池路由**

![图 046 模型池字段决定这项业务从哪个候选池路由](https://cds.miduo.org/api/reports/assets/2d7ab8ab1676c12753e1245fa72e8582d9f3ff0155ff389881dc21d8c7a5b56e.png)

5. 回到请求详情，按“key、appCaller、池、模型、Provider”的顺序把字段一一对应。

**图 075 请求详情用 requestId 串起 key、appCaller、池、模型和 Provider**

![图 075 请求详情用 requestId 串起 key、appCaller、池、模型和 Provider](https://cds.miduo.org/api/reports/assets/c559463c5a6e0df620dda4560687de11cbbe0821170450ecb8ab0a116a561dd4.png)

6. 在 appCaller 表格找到 chat 行，月预算填 `5` USD、单次预算预占填 `0.05` USD、RPM 填 `30`，点击该行“保存”。这是一组容易观察的教程测试值，不是生产推荐值。

**图 044 月预算与单次预算预占共同组成费用硬边界**

![图 044 月预算与单次预算预占共同组成费用硬边界](https://cds.miduo.org/api/reports/assets/bb6699362bfa7bd67bfe49070ceb7e18c3180e814602edb094e7f802a13d675d.png)

7. 对 vision 行重复填写同样测试值并保存。刷新页面，确认两行仍显示预算 5 USD/月、单次预占 0.05 USD 和 RPM 30；如果刷新后消失，不要继续真实调用。

**图 045 每分钟限流是业务级速率硬边界**

![图 045 每分钟限流是业务级速率硬边界](https://cds.miduo.org/api/reports/assets/14dc23eb9d2bb4c218fc6539c741417553ac38f268003e2610c6fce896619464.png)

8. 回到接入密钥，确认两把 Quickstart key 各自显示 60 次/分钟。最终有效速度取更严格的一层，因此本教程当前由 appCaller 的 30 RPM 先拦截；任何一个值都不代表租户总额度。

**图 059 单把 key 的每分钟上限可比 appCaller 更严格**

![图 059 单把 key 的每分钟上限可比 appCaller 更严格](https://cds.miduo.org/api/reports/assets/2b88455d6623093368e0937c06f2234fc41c15e840ee1f643acfb450a137e76e.png)

### 明确绑定模型池时怎么核对

本书主线使用 `auto`，因此 appCaller 行不会伪造一个专属池链接。如果管理员把特殊业务明确绑定到某个模型池，池名下会出现“查看模型池”。点击后可以在当前页查看池用途、策略、候选模型、健康和最近流量；预览当前表单关系，只有点击保存才会改变运行配置。

![appCaller 关联模型池就地预览](https://cds.miduo.org/api/reports/assets/d6ed02a5558eb0f45a49ec2b0f0b3dba729f2aa9b404ce7beff44a7901ce16ad.png)

### 再加上租户，你就得到完整的五层管理图

| 层 | 最容易理解的比喻 | 这里负责什么 | 不负责什么 |
|---|---|---|---|
| 租户 | 独立办公室 | 数据边界、成员边界、全部用量汇总 | 当前没有单独的总额度输入框 |
| key | 门卡 | 哪个接入方能进来、每分钟最多进多少次、何时撤销 | 不保存提示词和模型优先级 |
| appCaller | 工作单 | 这次调用属于哪项业务、月预算与业务速率是多少 | 不保存上游密钥 |
| 模型池 | 候选名单 | 兼容模型的优先级、健康和回退 | 不决定谁有调用权限 |
| Provider | 外部供应商 | 上游地址、凭据和实际承载模型 | 不代表租户成员身份 |

管理时从左向右排查：先看当前租户，再看 key，再看 appCaller，然后才看模型池和 Provider。不要因为模型失败就重新发 key，也不要因为某把 key 泄露就改整个模型池。

## 看到什么算成功

你能说明一把 key 限定明确 appCaller，但 key 本身不保存提示词正文和模型优先级。appCaller 使用 `auto` 表示按用途走默认池，模型池独立保存候选模型。chat 与 vision 的测试预算、预占和 RPM 已保存，key 仍各自保持 60 次/分钟。本章只核对配置关系，不把 dry-run 当成真实路由命中证据。

## 失败怎么办

- key 行没有 appCaller：这可能是旧共享 key，禁止给外部系统继续使用，按第 15 至 16 章建立 scoped key。
- appCaller 没有模型池：先确认它是否使用自动选择；需要专属路由时由 Owner 或 Admin 绑定兼容池。
- 模型池看不到教程模型：回第 7 至 8 章核对模型用途和追加结果，不要改 key 来补救。
- 三页字段对不上：先核对当前租户和 requestId，再交给管理员沿审计追踪，避免同时改三个对象。
- 想限制整个租户却只找到 appCaller：当前硬限制就是按业务和 key 分层设置。先覆盖所有生产 appCaller，再用租户用量汇总检查是否有遗漏；不要把各 appCaller 预算相加后宣称它是服务器保证的租户总上限。

## 本章小结

key、appCaller、模型池各司其职，既能组合成一次调用，又能独立轮换和治理。这是后续安全分环境与故障回退的基础。

## 下一章

点击 [[第 15 章：为测试和正式环境分 key]]，为 test 与 production 建立不同的接入身份。
