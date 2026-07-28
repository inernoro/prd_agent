| refactor | llmgw | 新增 lib/surface.ts 组件规格 SSOT：卡片内边距 / 次级块 / 容器间距四档 / 卡片操作行 / 主操作按钮规格，落实「同一角色只允许一种规格」 |
| fix | llmgw | 模型池三套指标展示收敛为一套：删掉 4 张只装一个数字的指标卡，汇总并入标题行小字；页头改 lg-page-heading，主操作统一 primary/sm，裸文字链接改 ghost 按钮 |
| fix | llmgw | Exchange 去掉 eyebrow 层；三步引导卡由常驻改为仅零数据时出现（并入空状态卡的有序列表，不再多一层盒子）；主操作按钮由大号带 icon 统一为 primary/sm 纯文字 |
| fix | llmgw | 按钮规格归一：sm 高度 30→32px 落进控件基准区间，按钮文字由 12px 提到 --fs-secondary（按钮文字是要读的，不是角标） |
| feat | llmgw | 排版漂移检测新增五个「规格种类数」维度（卡片内边距/圆角/容器间距/chip/主操作按钮），上限取自基准页自身而非拍脑袋的理想值 |
| docs | llmgw | 新增 doc/rule.platform.llm-gateway.console-design-tonality.md：把三轮实测校准出来的控制台风格调性固化为规则（一层卡片/余量均匀/七档字号+角色映射/icon 是扫描锚点/同一角色一种规格），含可测量判据与三层护栏 |
| fix | llmgw | Provider / 模型 / 审计 / 逻辑模型的页面标题从带边框卡片里提出来，与请求记录页同构（标题裸露在页面上，卡片只装展开后的表单） |
| fix | llmgw | 逻辑模型页内容区改为撑满剩余高度并自行滚动，空数据不再在下方留 600px 空白；模型池控件高度 30px→36px，对齐基准区间 |
| feat | llmgw | 新增排版漂移检测 e2e/llmgw-layout-drift.mjs：以请求记录页为基准，逐页量标题字号/标题是否被卡片包住/内容底部空隙/表头与单元格字号/单行行盒/控件高度，输出漂移清单 |
| fix | llmgw | 请求记录页表格最小宽度不再硬编码 1832px，改为按列自身下限推算；列宽从固定 px 改为内容驱动（长文本列吃剩余空间），空转宽度 51%→11%，1440 视口下不再横向滚动、齿轮不再压住表头 |
| fix | llmgw | 数值列（输入/输出/费用/速度）取消右对齐，统一左对齐，消除每列中间的空白山谷 |
| polish | llmgw | 请求趋势去卡片化：无边框无标题坐在表头正上方并可折叠；汇总指标从独立卡片并入标题行；去掉页面副标题；首屏非数据区 374px→250px（无趋势数据时） |
| polish | llmgw | 行首状态圆点改为失败/进行中整行左侧色条，成功行不再有装饰；表头 info icon 由 4 个收敛到 1 个；默认隐藏「用途」「结束原因」「客户端用户」三列（齿轮里可开） |
| polish | llmgw | 费用格式 USD 0.00509750 → $0.005097（符号前缀 + 有效位截断），费用列因此可收窄 |
| feat | llmgw | Provider 图标补 Replicate/Perplexity/xAI/Vercel/Baidu/Nvidia/Ollama/Modal 品牌色；无品牌素材的 Provider 改用按名字生成的确定性彩色首字母标记，取代统一灰云图标 |
| fix | llmgw | 请求记录页列宽改为「minmax(下限, 与下限等比的 fr)」：宽屏余量按比例摊给每一列，不再全部灌进 App 列在表格中间撑出空洞 |
| fix | llmgw | 列偏好存储版本 v3→v4：默认可见列集合（隐藏用途/结束原因/客户端用户）对存量用户生效，此前老记录会保留 12 列使改动失效 |
| fix | llmgw | 窄屏表格最小宽度由写死的 1832px 改为 1080px |
| refactor | llmgw | 控制台字体收敛为七档阶梯（以「请求记录」页为基准），theme.css 新增 --fs-*/--fw-*/--lh-* token，删除 9~24px 一次性字号 |
| fix | llmgw | 页头 SSOT 统一：全部 17 个控制台页面的 h1 都是 20px，Provider/模型/审计/影子对比/系统运维补上缺失的页面标题 |
| fix | llmgw | 修复会话过期后卡在「登录已失效，请重新登录」不跳转：api 层广播失效事件、AuthProvider 翻转登录态、路由守卫送回登录页并保留原页面地址 |
| feat | llmgw | 会话到点主动登出（不必等下一次点击撞 401），跨标签页同步下线，登录页说明失效原因（过期 / 成员关系被作废） |
| chore | llmgw | 新增字体阶梯守卫 pnpm check:typography，阻止再写阶梯外的硬编码字号 |
| refactor | llmgw | 新增字号角色表 lib/typography.ts：系统规定「表格/表单/正文用 14px，控件与字段名 13px，12/11px 只留给角标」，Provider、模型、接入密钥、审计、影子对比、逻辑模型、提示词策略、组织、用量九个页面改为消费角色常量 |
| fix | llmgw | 修复配置类页面正文比请求记录页糊一档：表头 11px→14px、表格单元格 12px→14px、表单输入 12px→14px、字段名 11px→13px，行高与行距对齐请求记录页 |
| polish | llmgw | 页面表格统一挂 .lg-data-table：表头底色 + 行分隔 + hover 高亮，与请求记录页表格同款；请求记录页筛选抽屉控件由 12px/30px 提到 13px/36px，与其可见工具条同档 |
| chore | llmgw | 字体守卫增加角色维度：th/td/labelStyle/inputStyle 等再降到 caption/micro 档即 CI 失败 |
| fix | llmgw | 改密换发新 token 后重排会话到期定时器（此前会话中途改密的用户仍会在旧 token 到期时刻被登出） |
| fix | llmgw | 会话失效广播携带失效 token 并按会话过滤，旧 token 的 401 不再把已换新 token 的标签页一起踢出 |
| fix | llmgw | 字体阶梯守卫接入 pnpm build，必跑的前端校验现在真的会执行它 |
| fix | llmgw | 排版漂移检测脚本改为从 checkout 推导路径、由 Playwright 自行解析浏览器，不再依赖作者机器的绝对路径 |
| test | llmgw | 更新 GatewayDataDomainGuardTests：字号/字重契约改为断言 token 定义 + 消费方，替代原来的裸 px 字面量匹配 |
| fix | llmgw | 漂移检测的「卡片内边距种类」有重复键，窄口径测量覆盖了宽口径，导致无 lg-card 类的卡片（如模型池卡）改内边距不会被发现；删除遗留窄口径测量 |
| fix | llmgw | 费用格式化修复科学计数法被裁尾零：极小额（如 1e-10）此前显示为 $1.000e-1，金额虚报 9 个数量级 |
| fix | llmgw | 同标签页 token 轮换期间的迟到 401 不再作废新会话：expireSession 携带失败请求当时的 token 并与当前 token 比对 |
| fix | llmgw | 模型池「了解路由机制」按钮不再嵌在链接里（button 套 a 是非法 HTML 且产生两个重叠的键盘焦点目标），改为按钮自身 navigate |
| fix | llmgw | 请求趋势收起后展开按钮被卡片 overflow:hidden 裁掉、再也展不开：收起态改为在流内保留 28px 高度承载按钮 |
| fix | llmgw | 漂移检测的模型池/趋势图 fixture 由空改为有数据：此前 /pools 只渲染空状态，池卡片、成员行、操作区的内边距与间距改坏了也照报「与基准一致」 |
| fix | llmgw | 模型池页内边距与间距归一到 surface.ts（卡片 16/12→14、指标块 9→10、间距 13/7/5→12/6），补齐上一条 fixture 修好后暴露出的 2 项真实漂移 |
| fix | llmgw | 排版漂移检测有漂移时非零退出：此前只打印「合计漂移项: N」仍以 0 退出，按退出码判定的 CI/本地校验会把回归当通过 |
| fix | llmgw | 字体阶梯守卫补上 React 字符串写法：此前正则只认 fontSize: 18，fontSize: '18px' 这种更常见的写法能从守卫底下溜过去 |
| fix | llmgw | 会话到期定时器绑定它排给的那个 token：改密换发新 token 时，旧回调若赶在 effect 清理前跑到会清掉新会话 |
| fix | llmgw | 漂移检测补齐 app-callers / exchanges / logical-models 三条路由的有数据 fixture；顺带修正 /exchanges/meta 的错形状（旧桩写 protocols/targetKinds/models，因页面恒空从未暴露） |
| fix | llmgw | Exchange 卡片规格归一：卡片 13→14、路由块 9→10、模型行 8→10、列表间距 10→12、路由块间距 7→6、批量行间距 10→8 |
| fix | llmgw | 逻辑模型页表头改用 TABLE_HEAD_CELL 角色常量（此前就地写 7px/9px + fs-secondary，比基准页表头糊一档）；卡片/间距归一到 surface.ts |
| fix | llmgw | 字体守卫的角色规则改为按花括号配平取整个声明块比对：此前 const th = { 换行后再写 fontSize: 'var(--fs-caption)' 永远匹配不上，规则形同虚设 |
| docs | llmgw | 风格调性文档头部补齐 doc 规范：H1 加「· 规则」后缀、改用 blockquote 版本/日期/状态、状态改为枚举内的「已落地」 |
