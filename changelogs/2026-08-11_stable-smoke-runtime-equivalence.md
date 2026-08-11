| fix | prd-api | 修复合法多图请求被上游误判后不切换备用 Offering 的问题 |
| fix | prd-api | 生图失败统一返回用户可理解且可恢复的中文错误，原始诊断仅保留在日志中 |
| fix | prd-api | 批量生图 SSE 异常统一脱敏，禁止向界面透传服务端异常原文 |
| fix | prd-api | 模型不存在、能力不匹配或凭据失效时立即隔离故障 Offering，避免后续用户重复踩中 |
| rule | all | 新增用户可理解错误分层规则，禁止向普通用户透传内部技术错误 |
| fix | prd-api | 修复专用图片模型首次发送误走旧聊天接口及多图响应解析问题 |
| fix | llmgw | 修正 Offering 路由配置后自动清除历史失败隔离状态 |
| docs | llmgw | 补充视觉创作新增图片模型的 LLMGW 配置与验收教程 |
| feat | prd-admin | 点击本人头像直接打开沉浸式编辑器，支持头像直传、描述生成预览并确认替换 |
| feat | prd-api | 新增本人生成图片转头像接口，并校验生成资产归属后再写入头像 |
| fix | prd-admin | 头像 AI 预览改为后台任务并展示服务端阶段进度，避免同步请求超时 |
| fix | prd-api | 新增本人头像后台生成任务与可读状态查询，浏览器断开不再取消生成和存储 |
| fix | prd-api | 图片平台返回尺寸太小时自动调整到安全尺寸，避免生成请求直接失败 |
| test | create-visual-test-to-kb | 验收截图清单保留唯一验收位，防止重复占位与漏测被误判为通过 |
| fix | prd-api | 头像对象键改为用户与内容哈希版本，避免上传或生成后 CDN 继续返回旧头像 |
| fix | llmgw | 新增幂等的环境变量管理员长期托管模式，避免每次重启重写密码并使会话失效 |
| docs | stable-smoke | 新增破窗账号、自动化账号和 CDS 项目身份的分层存储及状态登记规则 |
| test | stable-smoke | 将 CDS Compose 配置快照漂移与破窗账号连续重启可用性加入永久回归 |
| test | llmgw | 完成 CDS 固定版本连续两次重启、旧会话保持、固定管理员和自动化账号登录验收 |
| feat | prd-api | 新增白名单账号、一次性票据和不可续期短会话组成的合成测试登录通道 |
| feat | prd-admin | 新增自动消费短时票据并打开目标页面的合成测试登录页 |
| test | e2e | 新增 CDS 与正式环境合成登录模块入口冒烟及证据归档 |
| docs | stable-smoke | 沉淀 SSO 自动化登录、安全熔断、调度和验收报告操作规范 |
| feat | stable-smoke | 新增版本化核心业务功能台账、面包屑链路与变更自动纳入门禁 |
| feat | stable-smoke | 新增 CDS 和正式环境独立凭据、MAP 定向失败通知与双环境报告 |
| fix | stable-smoke | 撤销错误的 GitHub Actions 调度并改为 Codex 桌面端本地 48 小时自动化契约 |
| docs | platform | 沉淀核心业务稳定基线设计、分阶段落地和 CDS 发布回滚规则 |
| chore | e2e | 补齐稳定冒烟 TypeScript 类型校验依赖 |
| fix | prd-admin | 将合成登录页登记为有意隐藏的系统路由并恢复导航覆盖门禁 |
| fix | stable-smoke | 修复永久回归 caseId 大小写导致的执行证据漏对账，并在组合旅程中显式登记回归编号 |
| feat | stable-smoke | 稳定冒烟报告新增执行覆盖账本，为每个未执行项给出阻塞原因、代码入口、补跑命令和关闭条件 |
| rule | acceptance | 验收报告出现未执行项或覆盖不足时强制提供可操作的执行覆盖账本 |
| fix | prd-api | 修复历史用户教程完成状态为空时点击我已学会返回错误的问题 |
| fix | prd-api | 历史额度通知统一转换为包含恢复动作的用户可读文案 |
| test | e2e | 稳定冒烟新增教程完成幂等回归并消除通知加载时序误判 |
| test | create-visual-test-to-kb | 全面验收增加主管总览、模块证据预算、遮挡检测和失败证据门禁 |
| test | stable-smoke | 主管报告增加逐张视觉证据账本、异常前置、唯一图号跳转和关联测试方法 |
| fix | stable-smoke | 统一主管总览与逐张视觉门禁结论，避免截图数量达标被误判为视觉通过 |
| fix | prd-admin | 多图上传超过20张时明确说明限制和分批恢复方式，避免静默丢弃 |
| fix | prd-api | 多图损坏引用错误指出具体图片并说明其他输入已保留 |
| test | e2e | 稳定冒烟覆盖多图重排、删除、重复、超限和损坏引用边界 |
| fix | stable-smoke | 主管报告移除技术编号并把发布建议、干预项、完整面包屑和测试方法前置 |
| test | create-visual-test-to-kb | 区分采集文件与合格视觉证据并按148张逐状态、产品主题和设备门禁核销 |
| test | create-visual-test-to-kb | 知识库归档拒绝缺少逐图状态、路径、方法与设备信息的虚假视觉通过报告 |
| test | stable-smoke | 主管报告展开148项逐模块视觉任务并逐项标明结果、干预、面包屑与测试方法 |
| test | stable-smoke | 主管报告补齐人话版断言、影响面、证据关联、覆盖缺口与移动端验收设计 |
| test | create-visual-test-to-kb | 148个视觉验收位改为逐项唯一核销，缺位、重复占位或路径主题设备不一致时拒绝通过 |
| polish | stable-smoke | 主管报告移除工程设计矩阵，保留异常前置、完整面包屑、逐项结论、截图和方法跳转 |
| fix | cds | 透传模型网关调用方白名单，确保 CDS 录音转写消费 llmgw 权威 ASR 配置 |
| test | prd-api | 增加 CDS Compose 网关白名单透传守卫，防止部署配置回退 |
| test | stable-smoke | 增加 ASR 默认池主备、健康和网关配置权威永久回归 |
| ops | stable-smoke | 登记 prd-agent 项目级 CDS 自动化身份，统一正式预检、发布、回滚和报告归档的钥匙串入口 |
| test | stable-smoke | 完成十个核心模块 124 张唯一截图的视觉证据预算，并归档审核者优先的验收报告 |
| rule | stable-smoke | 将知识库首操作入口不稳定登记为候选回归，防止未定位问题被误报为通过 |
| fix | stable-smoke | 增加安全预检和参数校验，阻止帮助命令误启动测试并将开发者堆栈改为可执行阻塞项 |
| test | stable-smoke | 增加现场录音、暂停继续、静音拦截、不支持录音兜底及多图双端布局真实旅程 |
| fix | prd-api | 在任务创建前拒绝非法短视频链接，并返回包含恢复动作的用户可读提示 |
| test | stable-smoke | 增加大文件上传进度、文学移动端创建和短视频非法链接稳定旅程 |
| rule | stable-smoke | 将主管报告与技术附录拆分，并增加视觉关键状态与证据元数据强制门禁 |
| fix | stable-smoke | 所有 active 永久回归自动进入每轮计划，避免新增回归因未关联功能线而漏跑 |
| fix | cds | 将 ASR 调用方白名单和回退开关改为 CDS 可直接消费的确定值，禁止 Docker Compose 默认语法以字面量进入容器 |
| feat | stable-smoke | 自动生成主管逐项验收账本，异常项前置并关联详细面包屑、责任人和可点击测试方法 |
| feat | stable-smoke | 将双环境功能账本与百张级视觉证据合成为一份主管报告，避免旧结论覆盖最新执行状态 |
| fix | prd-api | 生图空输入错误改为说明结果和恢复动作的用户可读文案 |
| test | e2e | 新增双环境稳定冒烟执行器、caseId 覆盖账本、分批结果合并和真实业务旅程 |
| rule | quality | 定时稳定冒烟固定纳入完整矩阵、永久回归和安全凭据登记 |
| fix | prd-api | 允许合法无文本 PDF 与 Office 文件按附件保存，避免误判为损坏文件 |
| test | e2e | 补齐五种文件格式、网关只读审计和视觉教程遮挡的真实回归 |
| fix | prd-api | 视频直出成片改由后端鉴权下载并提供同源文件响应 |
| test | e2e | 新增登录隔离、文学流式创作和最低成本真实视频旅程 |
| fix | prd-admin | 修复画布缩小时生图进度条反向放大并被容器裁切的问题 |
| fix | prd-api | 删除视觉工作区时清理已结束的生图任务、明细和事件并阻止误删运行中任务 |
| test | e2e | 新增单图和双参考图真实生成、产物、进度恢复与零残留旅程 |
| fix | prd-api | 统一视觉生成占位的画布协议，确保刷新后可恢复生成进度与结果 |
| fix | prd-api | 修复音频转写按原始容器发送导致的协议失败，统一规范化 WAV、按模型协议组包并隐藏上游原始错误 |
| test | e2e | 新增真实音频转写、录音分片恢复、重复完成幂等和清理回归旅程 |
| fix | prd-api | 按部署实例定向消费转写任务，并原子接管上线前遗留的无归属排队任务 |
| test | e2e | 以稳定画布标识校验真实图片恢复，并隔离重试轮次的幂等键与清理对象 |
| fix | prd-api | 用部署隔离队列阻止旧 Worker 抢占新转写任务，并对音频模型空结果执行有效文本校验 |
| fix | prd-admin | 将部署隔离的转写排队状态显示为正常排队并持续订阅进度 |
| fix | e2e | 增加 CDS 目标提交与不可变部署版本冻结门禁，阻止部署切换期间误报业务失败 |
| fix | prd-api | 额度不足告警仅展示结果和恢复动作，原始 Provider、地址与上游错误只进入日志 |
| fix | cds | 调整预览徽标默认位置，避免遮挡应用左侧头像和导航入口 |
| fix | prd-admin | CDS 预览徽标存在时为头像与账户入口预留可点击空间 |
| fix | scripts | 修复稳定冒烟环境状态被数字退出码覆盖，报告统一输出 executed 或 failed 可读状态 |
| fix | prd-admin | 统一屏蔽内部错误细节并为文件上传、短视频解析提供用户可执行的恢复提示 |
| fix | prd-admin | 修复视觉生成进度条在不同画布尺寸下被裁切的问题 |
| fix | prd-admin | 修复文学创作移动端标题、模型选择和教程浮层的遮挡与溢出问题 |
| fix | prd-api | 将实时转写降级提示改为用户可理解的结果与恢复动作 |
| test | prd-admin | 增加用户可读错误与生成进度响应式边界回归测试 |
| test | prd-api | 增加实时转写降级提示不泄露内部实现的回归断言 |
| test | stable-smoke | 将视觉验收改为逐状态可审核证据，并分栏展示自动检查、人工视觉和严格结论 |
| test | stable-smoke | 主管视觉报告嵌入全部截图并提供面包屑、截图和测试方法跳转 |
| test | stable-smoke | 主管视觉报告将严格结论和异常项提前，并为 148 项账本逐项显示干预动作 |
| rule | stable-smoke | 将进度自适应和逐状态视觉证据缺口登记为永久回归项 |
| test | stable-smoke | 将本地可看报告与归档上传报告分离，按模块上传全部视觉证据 |
| fix | stable-smoke | 允许纯验收工具变更复用已部署业务版本，并记录运行时等价版本证据 |
| test | stable-smoke | 增加验收工具变更可复用和业务代码变更必须重新部署的版本门禁回归测试 |
| fix | prd-api | 头像生成在服务端校验视觉创作权限，并为 Google 图片协议补齐可追溯产物索引 |
| fix | prd-admin | 合成票据失败不再清退现有会话，折叠导航保留账户菜单并在关闭头像编辑器后停止轮询 |
| fix | prd-admin | 权限不足提示改为联系管理员开通，避免误导用户重复登录 |
| test | prd-api | 增加无文本附件、旧转录队列、头像权限和图片产物持久化回归守卫 |
| test | prd-admin | 增加匿名交换会话隔离、头像轮询取消和权限恢复动作回归测试 |
| fix | llmgw | 仅在 Offering 路由配置实际变化时重置隔离健康状态 |
| fix | stable-smoke | 开跑前完整校验网关地址和破窗账户凭据 |
| test | llmgw | 增加 Offering 编辑器重复提交与真实路由变更回归测试 |
| fix | prd-api | 内容安全拒绝不再损伤图片 Offering 健康状态 |
| fix | prd-api | 历史无归属转写任务仅由显式获权的正式部署接管 |
| fix | cds | CDS API 源码部署启动前自动保证 ffmpeg 可用 |
| fix | stable-smoke | 按组件构建范围验收 CDS 新镜像与安全复用镜像 |
| test | prd-api | 增加内容安全隔离、历史队列权威和 CDS ffmpeg 回归测试 |
| test | stable-smoke | 增加组件复用、陈旧组件拒绝和源码模式版本门禁回归测试 |
| fix | prd-api | 录音语义校验耗尽后按预计算候选切换备用 ASR Offering |
| fix | stable-smoke | 单环境稳定冒烟只对账实际选择的 CDS 或正式环境，避免虚构未执行项 |
| test | prd-api/stable-smoke | 增加 ASR 候选顺序与单环境复测成功判定回归覆盖 |
| fix | stable-smoke | grep 定向补跑只对账表达式选择的用例，避免其他计划项误记未执行 |
| fix | prd-admin | 头像生成任务在会话内保留运行标识，重开编辑器自动恢复轮询和结果 |
| test | prd-admin/stable-smoke | 增加头像任务恢复与 grep 定向复测回归覆盖 |
| fix | prd-api | 后台任务所有权加入稳定部署域，隔离同名分支的 CDS 与正式环境并保持滚动发布连续性 |
| fix | stable-smoke | 单环境报告将未选择环境明确标记为 not-selected，不再误报通过 |
| test | prd-api/stable-smoke | 增加部署身份隔离、滚动发布稳定性与单环境报告状态回归测试 |
| fix | prd-api | 首个图片请求保留模型适配后的参数，仅在备用 Offering 协议变化时重建请求体 |
| test | prd-api | 增加自适应图片模型参数删除与跨协议备用路由回归测试 |
| fix | prd-api | 图片 Offering 回退时按候选模型重新适配请求字段，头像任务创建支持部署隔离的幂等重试 |
| fix | prd-admin | 头像创建请求超时后复用会话幂等键，避免重复创建计费任务 |
| test | prd-api/prd-admin | 增加同协议自适应模型回退与头像创建超时重试回归测试 |
| security | prd-api/prd-admin | 合成登录一次性码改由 URL fragment 传递，避免进入代理请求日志 |
| fix | prd-api | 头像幂等任务使用确定性主键并补齐唯一索引定义，关闭并发重复创建窗口 |
| fix | stable-smoke | Playwright 进程异常退出强制整轮与主管报告判定不通过 |
| test | prd-api/prd-admin/stable-smoke | 补齐合成登录传输、头像并发幂等和冒烟进程异常回归测试 |
| fix | stable-smoke | 合成登录冒烟同步从 URL fragment 读取一次性码，恢复双环境业务旅程 |
| fix | prd-admin | 头像上传网络失败和异常响应统一转换为带恢复动作的用户可读错误 |
| test | prd-admin/stable-smoke | 增加头像上传网络异常回归并校验合成登录 fragment 契约 |
| fix | stable-smoke | 视觉门禁强制读取截图并核对实际哈希，缺失或篡改证据不得通过 |
| fix | stable-smoke | 视觉结论采用自动、人工和声明结果中的最严格状态 |
| fix | stable-smoke | 单环境主管报告将另一环境明确标记为未选择 |
| test | stable-smoke | 增加截图完整性、视觉严格结论和单环境主管报告永久回归 |
| fix | prd-admin | 头像上传与替换回调异常统一经过用户可读错误映射，屏蔽网络和模型协议诊断 |
| fix | stable-smoke | 存活进程持有的稳定冒烟锁不再因文件年龄被误删，预检实际验证双环境主应用和网关身份 |
| fix | prd-api | 后台任务兼容接管部署身份升级前的分支 owner，并将认领任务迁移到当前部署域 |
| test | prd-api/prd-admin/stable-smoke | 增加旧 owner 兼容、存活锁、真实身份预检和头像异常脱敏回归测试 |
| fix | prd-admin | 头像上传和生成应用成功后直接同步服务端结果，移除重复持久化请求及其假失败状态 |
| test | prd-admin | 增加本人、账户设置和管理员头像单次持久化契约回归测试 |
| fix | stable-smoke | 视觉证据门禁实际解码 PNG 数据并拒绝文本伪装、损坏或不完整截图 |
| fix | llmgw | 环境权威管理员口令复用本地账号至少十二位的统一强度规则 |
| test | llmgw/stable-smoke | 增加弱环境口令与伪造损坏截图永久回归守卫 |
| fix | prd-api | ASR 全流程增加早于看门狗的服务端截止时间、重试心跳和处理权条件写入 |
| fix | prd-api | 所有分支的旧 owner 仅允许显式获权的正式部署迁移，CDS 固定拒绝接管 |
| test | prd-api | 增加 ASR 截止时间与功能分支跨环境旧 owner 隔离回归测试 |
| fix | stable-smoke | CDS 全量测试失败或阻塞后，正式环境自动降级为只读健康检查并禁止业务写入 |
| fix | stable-smoke | 每个环境独立生成148项视觉计划、执行截图门禁并将功能与视觉账本合并为主管报告 |
| ops | stable-smoke | 非通过报告完成 CDS 在线归档和打开验证后定向发送 MAP 通知，交付失败显式阻断 |
| test | stable-smoke | 增加生产只读熔断、视觉严格结论和归档通知主链路永久回归测试 |
| fix | stable-smoke | 合成符合知识库准入字段的主管验收总览，避免正常报告必然归档失败 |
| security | prd-api | 视频直出状态和成片下载增加持久化任务归属校验，阻止跨用户读取 |
| test | stable-smoke | 双环境视觉证据改为296个环境限定验收位，禁止复用单环境截图通过门禁 |
| fix | prd-admin | 用户错误改为错误码许可清单，屏蔽网络地址、凭据和未知诊断文案 |
| fix | stable-smoke | 浏览器取证清单持久化 CDS 或正式环境标识，异常退出保留失败摘要并触发 MAP 通知交付 |
| fix | llmgw | 环境权威管理员口令先归一化再校验和播种，拒绝空白字符绕过强度规则 |
| test | prd-admin/llmgw/stable-smoke | 增加错误文案许可、取证环境、异常交付和口令归一化永久回归守卫 |
| fix | prd-api | 图片内容策略拒绝不再重试或计入模型故障，直出视频在归属库异常时提供签名恢复与自动补写 |
| fix | prd-admin | 浏览器禁用会话存储时头像任务清理安全降级，避免成功创建后再次抛错 |
| test | prd-api/prd-admin | 增加跨状态码内容策略、视频归属恢复和受限会话存储永久回归覆盖 |
| fix | prd-admin | 为认证与合成登录错误建立显式用户可读注册表，保留安全的结果说明和恢复动作 |
| fix | stable-smoke | 视觉台账标准化保留当前环境并支持从原始取证清单继承环境标识 |
| test | prd-admin/stable-smoke | 增加认证错误脱敏与双环境视觉台账继承永久回归覆盖 |
| fix | stable-smoke | 清理类用例发生重试即禁止正式环境写入，避免首次失败残留数据被最终通过掩盖 |
| fix | stable-smoke | CDS 测试地址每轮强制通过 preview-url 解析并拒绝与当前分支冲突的本地缓存 |
| ops | stable-smoke | 定时任务因活跃互斥锁跳过时持久化条件结论并定向发送 MAP 通知 |
| test | stable-smoke | 增加清理重试熔断、CDS 地址权威解析和重叠调度通知永久回归覆盖 |
| fix | prd-api | 图片请求级四百段响应不再累计模型路由健康失败，配置与能力错误仍保持隔离 |
| security | prd-api | 教程空进度复测清理接口仅允许短期合成会话操作当前用户自身数据 |
| fix | stable-smoke | 人工验收报告地址必须为无内嵌凭据的 HTTPS 在线深链 |
| test | prd-api/stable-smoke | 增加图片请求级错误、验收地址协议与教程空状态清理永久回归覆盖 |
| fix | prd-admin | 为群组、会话、分享、配额等稳定业务错误登记明确结果与恢复动作 |
| test | prd-admin | 增加邀请过期及其他稳定业务错误不退化为通用输入提示的回归覆盖 |
| fix | stable-smoke | 视觉证据必须同时具备自动与人工结论并采用最严格状态，CDS 地址失效时禁止复用缓存开测 |
| fix | stable-smoke | 人工验收报告必须包含当前运行标识与固定提交，禁止复用历史报告作为本轮证据 |
| fix | prd-api | 补齐图片内容安全错误码识别并限制音频规范化输出体积，避免错误恢复指引与资源膨胀 |
| test | prd-api/stable-smoke | 增加视觉双结论、地址熔断、报告身份、内容安全错误码和音频体积上限回归 |
| fix | prd-api | 音频规范化改为运行中监测并拒绝超限产物，禁止将截断音频误报为完整转写 |
| fix | prd-api | 合成登录票据新增哈希唯一索引与到期自动清理索引，避免定时复测长期积累 |
| test | prd-api | 增加音频体积边界与合成票据索引定义回归覆盖 |
| fix | prd-api | 多图生图按 Offering 协议走 OpenRouter 专用图片端点并统一自适应模型参数裁剪 |
| fix | prd-api | 直出视频任务归属增加即时清理接口与七日到期清理，治理定期冒烟存量 |
| test | prd-api/stable-smoke | 增加 OpenRouter 多图请求、自适应参数和视频冒烟清理回归覆盖 |
| fix | stable-smoke | 正式环境单独运行时强制降级为只读健康检查，写入旅程必须先通过同轮 CDS 验证 |
| fix | llmgw | 环境权威管理员口令拒绝页面改密，避免重启后口令回退和会话失效 |
| test | llmgw/stable-smoke | 增加正式环境单跑安全门与权威管理员改密拒绝回归守卫 |
| fix | prd-api | 图片 Offering 返回请求超时时累计健康失败，避免故障路由持续占据首选 |
| fix | stable-smoke | 主应用与网关身份预检分别使用独立超时窗口，避免后一个探测被提前取消 |
| test | prd-api/stable-smoke | 增加图片超时健康计分与身份探测独立时限回归覆盖 |
| fix | stable-smoke | 强制解锁仍校验锁 owner 存活状态，禁止并发启动第二轮写入测试 |
| fix | prd-api | 权威正式部署回收历史无 owner 的超时处理中转写任务并同步失败状态 |
| test | prd-api/stable-smoke | 增加强制解锁活锁保护与历史处理中任务迁移回归守卫 |
| fix | stable-smoke | 为新建互斥锁保留 owner 写入宽限期，消除空锁文件被并发执行器误删的竞态 |
| fix | prd-api | 生图额度耗尽保留网关分类与管理员恢复指引，不再退化为普通限流提示 |
| test | prd-api/stable-smoke | 增加新锁发布竞态与生图额度恢复指引回归覆盖 |
| fix | stable-smoke | 正式环境只读健康检查要求首页 HTML 与入口 JS/CSS 均返回成功且内容非空 |
| test | e2e | CORE-001 增加入口资源状态、内容类型、内容长度与应用根节点渲染断言 |
