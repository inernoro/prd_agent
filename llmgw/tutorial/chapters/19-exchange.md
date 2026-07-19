# 第 19 章 使用 Exchange

## 你在做什么

这一章为“教程假上游”创建一条 Exchange 映射，把外部模型标识转换成 Gateway 能调度的模型，并把启用的映射加入对应模型池。

## 为什么要做

有些上游不是 OpenAI 或 Claude 标准接口，地址、认证方式和请求形状都不同。Exchange 像翻译员：它说明目标地址、转换方式、上游模型标识和用途。它不代替租户 key，也不会在保存时自动调用上游。

## 开始前检查

- 顶部租户为“教程咖啡店”，当前角色有路由配置权限。
- 继续使用[[第 6 章：配置第一个 Provider|第 6 章]]公开教程桩。目标地址固定为 `https://map.ebcone.net/api/v1/stub/v1/chat/completions`；通讯标记固定为 `tutorial-stub-only`，它不是生产秘密。
- 密钥只在输入框中填写，不写进 URL、截图、说明或审计搜索词。
- 外部租户的常规 Exchange 使用 HTTP/HTTPS；只有豆包流式 ASR 使用 WSS。transport 与转换类型不匹配、明文 WS、内网、保留地址、localhost 和 URL userinfo 都会被拒绝。

## 跟我做

> 每做完一个编号步骤，就核对紧接在步骤下方的圈选图。同一步有两张图时，第一张确认入口或全貌，第二张确认字段或结果。

1. 从左侧“路由”进入“Exchange”，点击“新建 Exchange”或空状态里的“创建第一条映射”。

**图 089 从左侧导航点击“Exchange”，不用猜页面地址**

![图 089 从左侧导航点击“Exchange”，不用猜页面地址](https://cds.miduo.org/api/reports/assets/1859b9a8b590ff623a69d43e6680c8971ddbb37d00b817526c03aea0bdca4f30.png)

2. 名称填写“教程假上游映射”；“上游接口类型”选择“直接转发”，“认证方式”选择“Bearer”。这里的 adapter 就是“翻译规则”，`passthrough` 表示“不改请求内容，原样转发”，Bearer 表示“把上游通讯密钥放进标准认证头”，都不是 Gateway 租户 key。

**图 093 创建表单内直接选择转发方式和认证方式**

![图 093 创建表单内直接选择转发方式和认证方式](https://cds.miduo.org/api/reports/assets/d3bd7d40f6e2daf7851f1d1f925332d7ee891b039613395032c0da3937d0b286.png)

3. “目标地址”完整填写 `https://map.ebcone.net/api/v1/stub/v1/chat/completions`；“通讯密钥”填写固定教程标记 `tutorial-stub-only`。页面保存后只应显示“密钥已配置”，绝不能再次读回内容。

**图 094 通讯密钥创建时必填，加密保存且不进入响应和审计**

![图 094 通讯密钥创建时必填，加密保存且不进入响应和审计](https://cds.miduo.org/api/reports/assets/9f03f7b8aa98c0b6e999f2eed1eeebe35d2d45a69b7713ef511571e271821b82.png)

4. 在“模型映射”填写：上游模型标识 `stub-chat`，显示名称“教程 Exchange 对话”，模型用途选择“文字对话”，保持启用。本章只建这一条，避免凭空猜 vision 配置。

**图 095 每条上游模型标识必须映射到明确用途并可独立启用**

![图 095 每条上游模型标识必须映射到明确用途并可独立启用](https://cds.miduo.org/api/reports/assets/0d9f2bf2db600405f09834cf6b90c5d30a5b023dbe4352844aabfde90ab3a8d0.png)

5. 点击“创建并读回”。看到服务端读回卡片后，记下 Exchange id，并点击“打开本次审计”核对创建记录。

**图 091 服务端读回卡片展示目标、认证方式、模型映射和密钥状态**

![图 091 服务端读回卡片展示教程假上游映射、stub-chat、目标地址和密钥状态](https://cds.miduo.org/api/reports/assets/0da62055cc8ab05dbd901f82a52dcdb283839b46276236b58b84abde70f23aca.png)

**图 085 打开本次审计后，按当前租户核对创建动作、对象和时间**

![图 085 打开本次审计后，按当前租户核对创建动作、对象和时间](https://cds.miduo.org/api/reports/assets/7bf4e3d80e3ba99d57d77ed5f87ad70292d3e533beba21f903d0c7c51ce301b1.png)

6. 回到 Exchange 卡片，点击目标地址下方的“查看路由”。在当前页核对 adapter、目标地址、认证方式、配置来源和模型映射；安全边界必须明确写着不显示密钥、不访问上游、不改变路由。

**Exchange 路由就地预览：adapter、目标接口和模型映射一次看清**

![Exchange 路由就地预览](https://cds.miduo.org/api/reports/assets/20f335f370186a5770d5157bf007f185c07195748dae81252eb3d0a94da8d369.png)

7. 点击“去模型池”，找到默认对话池并点击“查看与维护”。先记录当前成员总数；在“选择模型”中找到标有 Exchange 来源的“教程 Exchange 对话”，再点击平台托管池的“追加模型”。

**追加前实图：默认对话池明确选中 Exchange · 教程假上游映射 / 教程 Exchange 对话**

![追加前实图：默认对话池明确选中 Exchange · 教程假上游映射 / 教程 Exchange 对话](https://cds.miduo.org/api/reports/assets/f0ccd34792ab4b15ee8c7fbceb26f61a56e9b6aac91edb5dfd98fd5d5e5b8d6c.png)

8. 点击前，候选项必须明确带 `Exchange ·` 来源标记；点击后，成员总数应只增加 1，该候选应从可追加列表消失，“模型成员”里新增一条 `stub-chat`。成员行当前不再重复显示 Exchange id，而且既有 Provider 也可能使用同名模型，所以不要声称某一行单独证明来源；“添加前的带来源候选 + 添加后数量增加 1 + 同一候选消失”三步合在一起才是页面证据。已有 Provider 成员不被删除或覆盖。

**追加后实图：成员新增 stub-chat、候选归零，教程聊天模型保持不变**

![追加后实图：成员新增 stub-chat、候选归零，教程聊天模型保持不变](https://cds.miduo.org/api/reports/assets/c57a8dbd92478c80f20ef599e1cfbc11f3add5f7ce314c04e98440d993183acf.png)

9. 需要接入豆包流式 ASR 时，新建独立 Exchange，把“上游接口类型”改为豆包流式语音识别，并填写供应商给出的公网 `wss://` 地址。服务端会拒绝“流式 ASR + HTTP/HTTPS”和“其他转换类型 + WSS”两种错配；保存时也会拒绝私网或保留地址，运行时会重新解析并固定公网 IP，TLS 仍按原始主机名校验证书，且不跟随跳转。不要把现有 HTTP 教程桩改成 WebSocket，也不要用未知付费上游做本章验证。

**图 093 的上游接口类型选择位于同一基础配置区，WSS 只改变安全边界，不改变密钥只写原则**

![图 093 创建表单内直接选择转发方式和认证方式](https://cds.miduo.org/api/reports/assets/d3bd7d40f6e2daf7851f1d1f925332d7ee891b039613395032c0da3937d0b286.png)

## 看图核对

缺少通讯密钥时，红框会直接阻止创建。不要把 Gateway 租户 key 填到这里；这里需要的是该外部平台自己的通讯密钥。

![红框提示第一次创建 Exchange 必须填写通讯密钥](https://md-private-1251304948.cos.ap-guangzhou.myqcloud.com/data/cds/img/reyipw3mxpdjb6ikxic4fxasre.png)

加入模型池后，红框标出的 `stub-chat` 是本次新增成员；左侧其他预定义池和已有成员没有被删除。

![红框标出 Exchange 模型已增量加入预定义模型池](https://md-private-1251304948.cos.ap-guangzhou.myqcloud.com/data/cds/img/rzn6fuvczphrwquj35cglffmve.png)

浅色主题下，红框覆盖的 Exchange 主体区仍应保持文字、按钮和状态可读。

![浅色主题下 Exchange 主体区完整可读](https://md-private-1251304948.cos.ap-guangzhou.myqcloud.com/data/cds/img/iw75a63manw7buohaymvqixheu.png)

移动端先打开导航，确认 Exchange、Quickstart、接入密钥和治理入口都能从同一左侧菜单到达。

![移动端导航中 Exchange 与相关工作区入口保持可达](https://md-private-1251304948.cos.ap-guangzhou.myqcloud.com/data/cds/img/i6tqd477kn4kp2mpge2apywnnm.png)

## 看到什么算成功

列表出现“教程假上游映射”，显示启用、密钥已配置、正确的转换类型和模型条数；页面没有显示密钥内容。审计可按 Exchange id 定位。模型池在添加前显示带 Exchange 来源的候选，添加后成员总数只增加 1、该候选不再可追加，且其他成员不变。

## 失败怎么办

- 创建时提示必须填写通讯密钥：本教程桩填写固定标记 `tutorial-stub-only`，不要拿 Gateway 租户 key 代替。
- 地址被拒绝：先检查 transport 是否匹配转换类型；常规 Exchange 只用 HTTP/HTTPS，豆包流式 ASR 只用公网 WSS。然后检查是否为内网、保留地址、带用户凭据或密钥参数；DNS 只要返回任一私网或保留地址就会整体拒绝。
- WSS 保存成功但执行失败：确认供应商证书覆盖 URL 原始主机名，且所有解析地址都可从 Gateway 访问；运行时不会使用代理、不会跟随跳转，也不会在 DNS 变化后改连未经验证的地址。
- 模型映射提示重复：合并大小写不同的重复项，每个 Exchange 内同一上游标识只保留一条。
- 保存提示版本冲突：保留当前表单内容，关闭后重新打开最新版本，再人工合并修改。
- 加入池时没有匹配池：先确认用途是否正确；没有程序池类型时回[[第 8 章：准备默认模型池|第 8 章]]补齐，不要改成错误用途硬塞。

## 本章小结

你创建了可读回、可审计、密钥不可回显的 Exchange，并把映射接入既有模型池。Exchange 负责协议和模型映射，租户身份仍只来自服务端会话或 key。

## 下一章

点击 [[第 20 章：配置 PromptPolicy]]，为 chat 和 vision 的业务身份增加可版本化的提示词规则。
