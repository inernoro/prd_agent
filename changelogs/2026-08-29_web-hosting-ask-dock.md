| refactor | prd-admin | 网页托管站点卡片按新设计重做：内容形态与来源分居缩略图两角、状态胶囊收进信息层、三种尺寸状态集一致 |
| feat | prd-admin | 站点卡片新增内容形态徽标（HTML / ZIP 站 / PDF / 视频 / MD）与真实数据角标（单页 / N 文件） |
| feat | prd-admin | 站点卡片大卡成果数据改为 浏览 / 有效链接 / 最近访问，体积退回元信息行 |
| refactor | prd-admin | 卡片操作分四层（常驻 / hover / 菜单 / 二级弹窗），hover 三项在触屏与键盘下经 kebab 顶部等价可达 |
| test | prd-admin | 新增 buildCardActionLayers 纯函数与等价可达守卫，替换原先断言 class 字面量的写法 |
| refactor | prd-admin | 网页托管桌面工具条收敛：只留搜索/组织方式/视图三件常驻，排序与卡片尺寸进「显示」气泡、文件夹与标签进「筛选」气泡 |
| feat | prd-admin | 网页托管新增来源筛选（手动上传/工作流生成/API 生成/保存自分享），选项由形态注册表派生 |
| feat | prd-admin | 主控台新增右栏「站点上下文」：一句挂着可点数字的结论 + 该站点链接清单 + 再建一条 + 访客视角 |
| fix | prd-admin | 网页托管投放面板默认折叠，不再遮挡新增的右栏站点上下文（用户手动展开过则记住） |
| fix | prd-admin | 站点卡片元信息时间改回创建时间，与列表的日期分组桶同源，消除「分组写 8 月 18 日、卡片写 5 天前」 |
| feat | prd-admin | 网页托管顶部改为两档语境切换（资产库 / 分享 N）+ 独立「以访客身份预览」动作 |
| feat | prd-admin | 新增分享档主屏：有效/已过期/已撤销三层分明 + 结论句 + 行内续期撤销复制，三种空态各给下一步 |
| refactor | prd-admin | 分享数据抽屉与访客抽屉改为「先结论后数字」，裸指标退为明细 |
| feat | prd-admin | 分享弹窗改为左配置右实时预览：改任何一个开关，右栏立刻画出访客会先撞上哪道门；底部一句复述即将生成的链接 |
| feat | prd-admin | 分享弹窗密码框合并为单输入框 + 明暗切换，不再需要在两处确认同一个密码 |
| feat | prd-admin | 上传弹窗补齐上传中与完成两态：真实字节进度 + 实测速率与预估剩余、解包阶段如实报已用时、可转后台继续 |
| feat | prd-admin | 上传完成态直接给可打开地址、立即分享、再传一个，并当场说明「向我提问」默认关闭 |
| feat | prd-admin | uploadSite 改走 XHR 以拿到真实上传字节进度（fetch 不暴露请求体发送进度） |
| feat | prd-admin | 提问面板的四种「问不了」拆成各自的卡片：需登录（带去登录按钮）/ 站点额度用尽 / 读不到正文 / 未开启提问 |
| feat | prd-admin | 访客页失败态按注册表分档：已过期说可续期、已失效说要新链接、不对外给去登录、密码试太频繁说清每分钟 10 次口径 |
| fix | prd-admin | 密码试太频繁（429）不再把访客踢出密码表单，改为留在原地提示并说明限流口径 |
| feat | prd-admin | 幻灯片托管页新增键盘邀请条（按正文里的框架痕迹判定），6 秒后自动淡出不挡内容 |
| fix | prd-admin | 补上 tokens.css 从未定义的 --bg-sunken（全仓 40+ 处在用，未定义使这些控件底色一直是透明） |
| test | prd-admin | 新增 5 组纯函数守卫：访客门组合、上传进度口径、提问拒绝优先级、访客失败态错误码、幻灯片判定 |
| fix | prd-admin | 提问抽屉浮层模式改为不透明底，修掉访客页顶栏按钮隔着面板幽幽透出来的重影 |
| fix | prd-api | 提问额度拒绝透出维度码（ASK_QUOTA_VISITOR / ASK_QUOTA_SITE_DAILY），此前两种闸都压成 QUOTA_EXCEEDED |
| fix | prd-admin | 提问额度拒绝按维度分两张卡，并优先展示后端带真实数字的原话，不再用静态文案盖掉 |
| feat | prd-admin | 提问「读不到本页正文」补「重试读取」按钮（后端读不到会退额度，重试不烧额度） |
| refactor | prd-admin | 分享管理改一屏表格三层（对齐设计稿屏 6）：七列表头、有效/已过期/已撤销同屏分段、右上角那组按钮改为筛选 |
| feat | prd-admin | 分享管理补「指向的站点」「数据」按钮、续期历史 N 次、撤销时间与原因、重新分享、底部口径脚注 |
| feat | prd-admin | 分享弹窗补齐设计稿缺件：站点身份条、必填徽标、三卡副标题、密码卡与有效期卡并排、高级折叠条 |
| feat | prd-admin | 分享弹窗右栏补地址栏示意、三条核对清单、二维码与「复制链接 + 密码」 |
| feat | prd-admin | 分享有效期补 3 天 / 14 天两档（设计稿档位）；保留既有的 1 天与永久，不做删减 |
| feat | prd-admin | 上传中态改大数字进度 + 真实解包分步清单（已解包 N/M、识别到入口、正在上传第 N 个）+ 中止按钮 |
| feat | prd-admin | 上传完成态补构建产物预览缩略图，「立即分享」改满宽主按钮、另两个降为次操作 |
| feat | prd-admin | 上传表单标签改 chips + 回车、分组改下拉（保留新建分组）、补封面说明，按钮改「开始上传」 |
| fix | prd-admin | 分享弹窗选中态从写死的蓝 #3b82f6 改回品牌 accent（设计稿整套强调色就是 --accent-primary） |
| fix | prd-admin | 分享弹窗密码开关从复选框改为 toggle，眼睛图标移进输入框内，「重新生成」改描边按钮 |
| fix | prd-admin | 分享管理每行改为独立圆角卡片（过期层虚线、撤销层淡红），不再是下划线表格行 |
| fix | prd-admin | 分享管理浏览数与结论句数字放大一档，可见性胶囊改三档配色（仅我可见灰 / 登录可见蓝 / 公开橙） |
| fix | prd-admin | 上传弹窗拖拽区虚线改 accent 橙，「转到后台 / 中止」与「打开站点 / 再传一个」改等宽两列 |
| fix | prd-admin | 分享数据抽屉在计数字段缺省时整屏崩溃（toLocaleString on undefined），改走 fmtCount 并补源码守卫测试 |
| feat | prd-admin | 补齐设计稿规格 token（文字第三档、圆角六档、JetBrains Mono、侧栏/井底色、角标蒙版、头像底、焦点环），深浅双写 |
| fix | prd-admin | 网页托管外壳按设计稿改成三列贴边屏框：52px 通栏顶栏（含团队切换器）、左栏 212 贴边、工具条归入中列、右栏 300 贴边 |
| fix | prd-admin | 工具条按设计稿重排：搜索定宽 280 带 / 提示、组织方式四档常驻（不成立的置灰）、显示带当前值摘要、视图切换后置、上传网页 |
| fix | prd-admin | 卡片网格改 minmax(236,1fr) 拉伸左对齐 + gap 14，修卡片与结论行错开、右侧留死区 |
| fix | prd-admin | 站点卡片按设计稿屏 2 重做：操作条压回缩略图内（hover 浮起 + 渐变底衬）、状态胶囊改小圆角矩形并换回强调色系、三档尺寸各自的圆角/缩略图高/字号、归属头像在个人空间也渲染 |
| feat | prd-admin | 大卡补齐设计稿的四格成果数据（浏览/访客/有效链接/最近访问）；中卡元信息补访客数；标签行右端补更新时间 |
| feat | prd-api | 站点列表返回每个站点的独立访客数（按 userId / IP 去重聚合），卡片「N 访客」不再拿浏览数冒充 |
| feat | prd-api | 上传/替换时扫入口 HTML 的框架签名落 IsSlideDeck，幻灯片成为第五种内容形态（设计稿屏 2 的五形态补齐） |
| fix | prd-admin | 缩略图占位改设计稿两态：斜纹井底 + 扫光（正在取正文）/「取不到正文 · 显示占位」暖色提示（降级态）；PDF 缩略图去掉整块红渐变，改中性纸片 |
| fix | prd-admin | 网页托管主控台外壳按设计稿屏 1 对齐：新增常驻左栏（空间/分组/标签），组织方式补「按来源」档，列表上方补结论行，上传按钮移到工具条右端 |
| refactor | prd-admin | 分组逻辑抽成 siteGrouping.ts（含按来源分节与档位可用性），结论行抽成 libraryHeadline.ts，各自带守卫测试 |
| feat | prd-admin | 空间选择记住上次停留位置（sessionStorage），切空间时不成立的组织方式自动落回按时间 |
| feat | ops | 每日验收清单扩到 8 条：按业务功能台账的 P0 功能线加 5 条「页面产物可见」（外壳/网页托管/知识库/缺陷/视觉创作），只测读路径 |
| fix | prd-admin | 站点卡片同一行等高（grid item 拉伸后内部盒子仍是内容高，导致下边缘参差），末行沉底 |
| fix | prd-admin | 卡片 hover 条对齐设计稿：淡入 + 上移 6px / 180ms，取消设计稿没有的卡片整体上抬；触屏判据从宽度断点改为 hover 能力查询 |
| fix | prd-admin | 右栏「选中的站点」在该站点没有任何有效链接时改为「创建分享链接」主操作，不再指向一条不存在的链接 |
| fix | skill | design-replication 的文案提取口径从「叶子节点」改为「自有文本节点」，修掉与图标同级的标签被整片漏读造成的假缺失 |
| fix | prd-admin | 站点卡片标题恒定单行 + 省略号，长标题不再把整行卡片撑高留出空白（用户原话「胡子太长」）；标签/时间行恒定渲染，同档尺寸卡片高度确定 |
| feat | ops | 新增每日关键功能验收脚本 scripts/smoke/daily-acceptance.mjs：断言分享页 iframe 里真的有正文、勾选框在真实指针下可点，失败非零退出 |
| fix | prd-admin | CDN 注入的 cloudflareinsights beacon 是 type=module，导致每个托管站点都被踢出 srcDoc、落到会白屏的直链路径；预览前剥掉该遥测脚本 |
| feat | skill | design-replication 升到 v2.0.0：新增取证/取规格/token 对照/机械核对四个脚本 + 对抗式审查模板，流程从「渲染-实现-并排」扩成「取证-规格-落 token-实现-核对-审查-归档」 |
| fix | skill | design-replication 的 render/pair 不再写死 chromium-1194 路径，改为按目录名探测 |
| fix | prd-api | HostedSiteService.DetectSlideDeck 里 Encoding 未限定命名空间导致 CI 镜像构建 error CS0103，改为与本文件其余处一致的 System.Text.Encoding |
| fix | prd-api | 站点正文代理不再一刀切拒绝包装站：Markdown 包装站的壳子就是服务端渲染好的完整正文，放行给 srcDoc；PDF/视频壳仍拒绝 |
| fix | prd-admin | hasFetchableHtml 改 default-deny 白名单，Markdown 包装站走 srcDoc；修掉 MD 站分享页标题栏下一片白 |
| fix | prd-admin | 分享页迟到的原文不再无条件丢弃：只有直链**确实加载出内容**时才丢，否则白屏页会把唯一能救场的 srcDoc 也扔掉 |
| fix | prd-admin | 站点既无原文又无入口地址时，分享页说清「没有可加载的入口地址 + 站点 ID」，不再摆一个 about:blank 的空 iframe |
| test | prd-admin | 两条反向锁死事故写法的用例改写成行为契约（hover 条整条接管指针 / 包装站一律不取正文） |
| fix | prd-admin | 卡片 hover 条 hover 时以整条宽度接管指针，盖死左下角批量勾选框——真人点不动（程序化 click 却能过）；容器改为恒 pointer-events-none，只有按钮自己可点，补真实指针契约守卫 |
| feat | prd-admin | 网页托管右栏补齐设计稿三态：未选中=站点上下文·最近动过 / 选中 1 个=选中的站点 / 选中多个=批量操作；批量操作从列表上方横条收进右栏（窄屏仍保留横条） |
| fix | prd-admin | 右栏「最近动过」改为取真正 updatedAt 最大的站点，不再是当前排序下的第一张卡 |
| fix | prd-admin | buildShareLedger 排序读真实时钟、结论句读注入时钟，两处判据不同源导致用例随日期漂红；now 统一注入 |
| fix | prd-admin | 全站正文字族落到 var(--font-body)：Inter 早已加载、token 早已存在，但从未落到 body，正文一直吃 Tailwind 的 ui-sans-serif 兜底 |
| feat | prd-admin | tokens.css 新增字距阶梯（眉标/徽标/meta/标题/display/数字六档）与结论块 info callout 双主题 token |
| feat | prd-admin | 网页托管右栏按设计稿屏 1 重做：站点卡合并缩略图与标题、info 结论块、链接行内续期/数据、描边「再建一条链接」、新增「本周分享动态」 |
| fix | prd-admin | 站点结论句补访客数口径（累计 N 次访问来自 M 位访客），到期改说「其中 N 条 X 天后过期」 |
| refactor | prd-admin | fmtSize / relativeTime 抽进 siteFormat.ts，SiteCard 与 SiteContextPanel 不再各存一份 |
| feat | platform | 设计复刻技能加样例数据录制-回放：实现页按设计稿那套数据渲染，文案覆盖率才读得出信号；配漂移守卫防 fixture 过期 |
| ci | platform | scripts/tests 下 15 个 *.test.mjs（160 条断言）此前没有任何 workflow 引用，接进 release-script-test |
| feat | platform | 12 块设计画板全部量出档位表并固化进仓库（带画布 sha256），token 闸门跑通，缺项收敛到 8 个真值 |
| fix | platform | 取证按画板选择器切，不再按 y 区间：并排摆放的三个上传态原先取出的文案是三屏并集（12 屏里 5 屏的文案证据是错的） |
| fix | platform | tokens-map 按维度限定候选 token（字号不再匹配到圆角 token），项目未用 token 管的维度如实报「不这么管」而不是每档算缺 |
| fix | platform | 取证脚本改用 playwright-core + 容器预装浏览器，setup 不再卡在下载浏览器上 |
| feat | platform | 设计档位表可固化进仓库（带画布 sha256 + 量取时间），改版直接 diff 两份规格；tokens-map 可直接吃这份导出，不必重跑取证 |
| feat | platform | 复刻取证补三件能力：点开弹窗抽屉再量（--click）、收 iframe 里的文案、按屏声明渲染下限；样例数据可声明放行旁路接口且必打印 |
| docs | web-hosting | 访客阅读页对设计稿机械核对：覆盖率 41%，23 条硬缺失记入台账（提问面板与评论区互斥、缺模型可见性行、缺配额行、顶栏缺分享人与有效期） |
| feat | prd-admin | 网页托管分享改成一步：卡片「分享」就地展开下拉，一键生成链接并复制，可见性与有效期就地改，密码/短链/开场问题才进高级弹窗 |
| feat | prd-api | 新增 PATCH /api/web-pages/shares/{id}，就地重设分享链接的可见性与有效期（与「续期累加」分开），改动写入同一本审计账 |
| refactor | prd-admin | 分享列表由七列伪表格改成行式列表：一条链接两句话 + 一个浏览数，操作 hover 出现 |
| fix | prd-api | 分享列表的「续期次数」只数真的续期，不再把创建/复用/重设也算进去 |
| feat | prd-admin | 热点组件加结构基线：只记几何与契约属性、不记颜色圆角，共享组件一改就当场看见哪几屏跟着变 |
| feat | prd-admin | 「向我提问」重做成单节点形变坞：收起胶囊 → 中下玻璃长条（开场问题浮在上方）→ 右侧对话栏 → 竖条 |
| feat | prd-admin | 提问坞支持三档折叠（对话栏 / 竖条 / 胶囊）与输入框折起，每一档都留轮次角标 |
| feat | prd-admin | 提问坞加本次访问的提问历史，点一条滚回那一轮；⌘K 唤起、Esc 逐级后退 |
| feat | prd-admin | 提问入口图标换成 MAP 品牌标（M 与三个节点），品牌路径抽成共用常量 |
| refactor | prd-admin | 对话流抽成 AskThread，浮层坞与预览弹窗内嵌面板共用同一份渲染 |
| feat | prd-admin | tokens.css 补提问坞玻璃 token（暗/浅双写），不再靠硬编码深色 |
| test | prd-admin | 新增提问坞几何守卫（居中/不溢出/让开手势条/竖条撑满），markdown 接线守卫改为扫全目录 |
| fix | prd-admin | 竖条上的「向我提问」四个字改逐字换行——flex 列里 writing-mode 撑不出高度，真机上那一格只有 4px、字整个没了 |
| fix | prd-admin | 幻灯片站的「方向键翻页」邀请条在提问长条展开时让开，不再和额度小条叠在底部正中 |
| fix | prd-admin | 提问坞浅色档两个近白值改成暖纸色——浅色主题里禁止纯白 rgba，之前只跑了定向测试没跑全量，漏到交接才发现 |
| docs | prd-agent | 新增「向我提问」形变坞交接清单，并登记进文档索引 |
| test | prd-agent | 对话半边闭环验通：真人路径提问，侧栏答出正文原话、模型行可见、额度真减，截图与正文并排可比对 |
| feat | prd-api | 「向我提问」开场问题自动生成：开启提问 / 重新上传 / 分享页兜底时读一遍正文，写出访客最可能问的 5 句 |
| feat | prd-api | 新增按正文重新生成开场问题的端点，并在配置里透出题库来源（系统生成 / owner 自己写的） |
| feat | prd-admin | 提问设置抽屉显示题库来源标签与「重新生成」，owner 改过之后不再被自动覆盖 |
| test | prd-api | 新增开场问题解析与生成判据的单测，以及三处 fire-and-forget 接线的源码守卫 |
| fix | prd-api | 开场问题生成区分「模型调不通」与「模型答得没法用」：前者不盖版本戳、进冷静期自动重试，后者才盖戳 |
| feat | prd-api | 重新生成端点按四种结局给各自的下一步文案，不再压成一句「失败了」 |
| fix | prd-api | 提问一个字都没生成出来就失败时退回配额——此前网关不可用每问一次白烧一次额度 |
| ops | prd-agent | CDS 预览把「向我提问」两个调用方切到 HTTP 权威（模型池在 llmgw 侧，留在 inproc 会去查 MAP 那张空表） |
| feat | prd-api | 「向我提问」新增剩余额度旁路端点（只读不加一，匿名可用） |
| feat | prd-admin | 阅读页提问面板显示本页今日与访客小时剩余额度 |
| polish | prd-admin | 提问面板免责句补齐后果说明，开场问题加来源标题，输入框提示改为限定本页 |
| test | prd-admin | 新增额度端点接线守卫（前端路径 vs 后端 attribute + 匿名开放） |
| polish | prd-admin | 剩余额度从消息区顶部挪到面板顶栏右侧（对齐设计稿，且不随对话滚走） |
| docs | prd-agent | 阅读页核对前后对照入账，并记下访客页无浅色档这条既有缺口 |
| fix | prd-agent | CDS 预览的 Mongo / Redis 连接串改吃 CDS 注入的带凭据变量——共享基础设施开鉴权后，无凭据串一重启就起不来 |
| ops | llmgw | 对话默认池按实测证据停用 86 个不可调用成员（用户裁决），停用后全量复测 0 漏网 |
| docs | doc | debt.web-hosting #65 结清：262 个成员逐个实测 + 治理结果 |
| ops | llmgw | 再停 5 个 429 限流成员（两个 :free 冗余 + mistral-large 三变体），两个误伤对象经复核保留 |
| fix | prd-api | 修 5 处方法名夹空格导致的语法错误——测试项目从未编译过，CDS 只建应用项目所以没暴露 |
| fix | prd-api | 修三条自己写坏的守卫：取窗越界、钉死整串名单、把有意的容错当成缺陷 |
| docs | doc | 交接文档 H1 与两份目录登记的标题对齐 |
| fix | prd-api | 分享列表支持按站点过滤，判断「这个站点有没有分享」不再受全局最近 100 条窗口影响 |
| fix | prd-admin | 一步分享建链接前按站点复查，不再给已分享的站点重复建链接 |
| fix | prd-admin | 重传大 ZIP 时解包进度真的显示出来，不再全程停在「正在建立上传连接」 |
| fix | prd-admin | 提问额度窗口过期后能接着问，不必刷新页面 |
| fix | ops | 每日验收按站点查分享链接，不再每天重复建公开链接 |
| fix | prd-admin | 一步分享的建前复查查不通时停手，不再 fall through 建出重复链接 |
| fix | prd-admin | 已登录的人撞访客额度时不再给「去登录」——登录一圈回来还是同一档额度 |
| fix | prd-api | 提问流正常结束但一个字没产出时退回额度并报错，不再把空气泡标成「答完了」 |
| fix | prd-admin | 上传完成那一屏的地址不再把绝对地址拼成打不开的串（对象存储回绝对、本地磁盘回相对，两种都要能打开） |
| fix | ops | 每日验收查分享链接失败时抛错停手，不再 fall through 每天多建一条公开链接 |
| fix | prd-api | 重新生成开场问题没写成时把「owner 手写」标记还回去，不再让他那份题失去保护、等网关恢复后被静默覆盖 |
| fix | prd-api | 停用模型的查找补齐第三个别名，缺 ModelName 的那类模型停用后不再照发 |
| fix | prd-api | 开场问题盖戳要求正文版本没变过，跑一半被重传不再用旧正文的题盖新版本 |
| fix | prd-api | 站点入口判据收成唯一一处，index.htm / 其它 HTML 打包的幻灯片不再被当普通网页 |
| test | prd-api | 源码守卫改用大括号配对取方法体，消灭「手写固定长度窗口」这一整类错误 |
| docs | doc | debt.web-hosting #66：被顶掉的生成不立刻重排，判为扩范围记账 |
| fix | prd-admin | 分享「仅我可见」文案改口径为「仅我和协作者」，与后端实际放行范围一致；可见性标签与规范化判据收敛成一份 SSOT |
| fix | prd-admin | 站点右栏的存量链接可见性不再兜底成 owner-only（后端按 public 放行，兜错方向会谎报更安全） |
| fix | prd-api | 保存提问配置时题库改为可省略：只有用户真的编辑过才回写，避免抽屉里的旧值盖掉刚生成的题并把站点钉成 manual |
| fix | prd-api | 「重新生成开场问题」与后台生成抢同一把站点锁，重复触发返回 Busy 而不是再烧一次模型调用 |
| test | prd-api | 输出租约接管用例改为显式判过期，不再赌四次 Mongo 往返能在 150ms 租期内跑完（CI 上偶发超时） |
| fix | prd-admin | 一步分享面板顶上那句总结不再说「只有你自己」——上一轮改标签时漏了这第三处，同一面板自相矛盾 |
| fix | prd-api | 暂时读不到正文（对象存储抖动）不再盖版本戳，存储恢复后自动重试；只有确定没有正文才盖 |
| test | prd-admin | 去掉钉死错误文案「只有你自己」的断言，改成断言行为（修那句话的人不该 CI 变红） |
| fix | prd-api | 站点访客数补上存量单站点分享（只有 SiteId 没有 SiteIds 的那类），此前这类分享的访问被整条漏掉、卡片仍显示 0 访客 |
| refactor | prd-api | 「一条分享指向哪几个站点」收敛成 WebPageShareLink.TargetSiteIds()，此前在读路径上被各写了一遍 |
| fix | prd-api | 开场问题落库没匹配上时不再报成已生成，新增 Superseded 结局并给出实话 |
| fix | prd-api | 存量站点 owner 手写的开场问题不再被自动生成冲掉（AskQuestionsSource 缺字段时按手写处理） |
| fix | llmgw | 批量能力维护传了 modelIds 但一项都不合法时直接拒绝，不再静默扩成整个平台全刷 |
| refactor | llmgw | modelIds 归一化与校验下沉到 GatewayConfigurationProvisioning，可被直接测 |
| fix | prd-api | GPT-5 家族的 max_tokens 收编下沉到限流函数内部，Exchange 原始请求路径不再同时带两个字段被上游拒 |
| fix | prd-api | 收编时保留调用方原本的较小值，不再按「目标字段不存在」把上限整个塞进去 |
| fix | ops | 每日验收找站点改用服务端 keyword 过滤（原先传的 pageSize 被忽略，只拿回 50 条，会重复建同名站点） |
| fix | prd-api | 读配置与重新生成端点回给面板的来源标签不再兜底成 auto，存量站点手写的题不再被标成「系统读正文生成」 |
| fix | prd-admin | 「重新生成」后的来源标签改用后端回的值，被别人顶掉时不再谎称是系统生成的 |
| refactor | prd-api | 「这批题是谁写的」收敛成 AskOpeningQuestions.ResolveSource 一处，读写两侧共用 |
| security | prd-api | 提问配置的写路径补角色门：viewer 不能再替 owner 烧模型调用、覆盖题库 |
| fix | prd-api | 流中途的 error chunk 算作调用失败，不再把残句当正常回答并盖版本戳 |
| fix | prd-api | 这一版得不出题就清空题库，不留上一版内容写的问题 |
| fix | prd-api | 配额只退自己真扣过的那一格，Redis fail-open 时不退 |
| fix | prd-api | 站点访客数并入分享链接访问，纯分享站不再显示 0 访客 |
| fix | prd-admin | 重传时把解包进度键传下去，换 ZIP 的进度面板不再停在等待中 |
| style | prd-admin | 去掉两处 emoji（规则 #0） |
| fix | prd-api | 模型池调度改为跳过「库里明写着已停用」的成员，让停用开关对托管默认池真正生效 |
| docs | doc | debt.web-hosting #63 结清并更正根因（不是权限拦截，是托管池删不掉 + 停用开关调度侧没读） |
| fix | prd-api | max_tokens→max_completion_tokens 改名扩到整个 GPT-5 家族，修掉 5.0–5.5 全部调不通 |
| docs | doc | debt.web-hosting #65 记录 262 个池成员的逐个实测结果与五类失败分布 |
| fix | llmgw | intent 池成员资格判据改读 Capabilities，修掉「批量导入模型永远进不了意图池」的死锁 |
| refactor | llmgw | intent 兼容判据收敛为唯一一份 GatewayModelPoolTypeRegistry.IsIntentCapable，Program.cs 的拷贝改为委托 |
| feat | llmgw | 模型能力维护支持 modelIds 精确圈定，不必按平台整片刷 |
| docs | doc | debt.web-hosting #64 结清：意图池判据死锁的根因、修法与实测证据 |
| fix | prd-api | 重新生成失败的还原判据补齐第二个条件：并发 editor 保存的手写题不再被改回 auto（判据抽成 RestoreAskSourceFilter 唯一定义，打真库三条用例） |
| fix | prd-admin | 重传站点时进度屏接上：判据抽成 showsUploadProgress，重传（编辑+选文件）放行，纯改元信息仍不占这一屏 |
| chore | docs | 本 PR 的 42 个 changelog 碎片按 AGENTS.md 规则 #4 合并为一个文件（177 行原样保留） |
| fix | prd-api | 网关「跳过停用成员」不再被 MAP 旧副本短路：停用判定不由 modelConfig 把门，MAP 侧只在 GW 无权威记录时参与 |
| docs | doc | 提问坞交接清单按当前状态重写：导读与表格不再打架、预览给三条真实深链、按 §10 去掉逐文件源码清单 |
| fix | prd-admin | 重传时「中止」按钮真的能中止：reuploadSite 接 AbortSignal，中止不再只是把进度屏藏起来而请求照跑 |
| test | prd-api | 重传进度接线守卫改钉不变量而非完整签名，加参数不再误判红（uploadId 被拿掉仍会红）|
| fix | prd-api | 重新生成开头那笔清除也带 CAS：读与清之间别人保存的手写题不再被改回 auto |
| fix | prd-admin | 中止重传后如实说明「停的是浏览器这一端，服务端可能仍会做完」，不再让人以为替换没发生 |
| fix | prd-api | 重新生成的并发判据改认配置修订号，不再逐个枚举字段（漏掉「改了一版手写题」那类） |
| fix | prd-admin | 「已分享」标记改为从分享列表派生，撤销链接后卡片状态立刻跟上，不用整页重拉 |
| fix | prd-admin | 分享预览把三档可见性拆开说：登录可见不再被说成「团队外打不开」（原文案往更安全方向谎报） |
| fix | prd-admin | 链接未生成时不再画可扫的二维码，改为明确的占位块，避免扫出一条不存在的路由 |
| fix | prd-admin | 迟到原文的取舍改按已过时间判，不再拿 iframe load 当「已画出内容」，修掉直链白屏时被丢弃的兜底 |
| fix | prd-admin | 一步分享总结与访客拒绝页补齐可见性区分：owner-only 不再谎称要输密码，登录可见不再被说成要团队成员身份 |
| fix | prd-api | 重新生成冲突时返回的题库字段名与正常路径对齐，修掉抽屉清空后覆盖别人题库的丢数据路径 |
| fix | prd-admin | 访客「去登录」改传 returnUrl，登录完回到原来那一页而不是首页 |
| fix | prd-admin | 一步分享面板三处加载态改用 MapSpinner，按前端架构规则统一动效 |
| fix | prd-admin | 小卡的 kebab 改为压在缩略图右上，修掉每张小卡正文底下那截空白（永久预留一行放 hover 才显形的按钮）|
| fix | prd-api | 分享链接续期宽限窗收成唯一判定源 ShareRenewPolicy，续期端点、分享列表、数据抽屉不再各写一遍 AddDays(-7) |
| fix | prd-admin | 数据抽屉结论句只对真能续期的过期链接许诺「续期即可复活」，已撤销与过期超窗的如实分开说 |
| fix | prd-admin | 访客样本命中 5000 条上限时不再算人均访问次数，访客数如实标成「至少 N」 |
| fix | prd-admin | 访客抽屉不再把分页截断说成匿名访客——匿名人数后端没给，算不出来就不出这句 |
| fix | prd-admin | 访客过期页不再无条件承诺「点一下续期就能重新打开」——过期超窗或已撤销时作者根本续不了，改成续期与重新分享并列 |
| feat | prd-api | 提问改为默认全开：AskEnabled 改三态（null 未表态=开 / true 明确开 / false 明确关），判定收成 AskAccessPolicy.IsAskOn 唯一来源 |
| feat | prd-admin | 站点弹窗的提问开关跟随默认全开口径，不再把「没表过态」显示成关 |
| fix | prd-admin | 站点卡选中态去掉外层 outline，只留内框那一个圆角矩形；根节点半径改跟内框一致，顺带修掉新上传光环也偏圆一圈 |
