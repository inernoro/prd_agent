# MAP 核心功能历史问题与经验 · 指南

> **版本**：v1.0 | **日期**：2026-10-12 | **状态**：草案（历史索引；本次未重新执行业务复验）

**一句话**：从关心的功能直接找到过去怎样出错、原因是否确定、最近还有什么要盯。
**谁该读**：关注反复痛点的产品负责人、验收 Agent 与修复负责人。
**读完能做什么**：回看已登记历史，沿原编号找证据，把针对性验证带到下一轮。

入口：[热点与核心清单](spec.platform.core-business-checklist.md) · [执行手段](guide.platform.core-business-acceptance.md) · [三池维护规范](rule.platform.acceptance-memory.md)。H 是历史主题索引，不是新增缺陷编号。

## 近期视图

窗口：2026-09-29 至 2026-10-12。下列事实来源于台账和自动化 memory 的时间检查点，不是本次重新取证。memory 顶部“最近一轮”和更新时间仍停在 10 月 8 日，本册取后续有明确日期的记录，不让旧标题覆盖新事实。

| 近期要盯什么 | 为什么现在要盯 | 频次如何解释 | 历史与下一步 |
|---|---|---|---|
| 网页首轮稳定性与清理 | 10/12 重试通过，但首次尝试残留为零未被证明 | 新问题；不能把 10 条 flaky 当 10 个独立事故 | [H11](#h11)：首轮、相关回归、清理账分别验 |
| 图片引用与调用入口契约 | 10/09 参考图数量契约入台账；10/10 旧巡检请求再次漏参数 | 台账记有重复逃逸；窗口内完整事件次数待补 | [H02](#h02)、[H14](#h14)：零/一/二/三图与前置拒绝 |
| 固定目标通知 | 10/08、10/10、10/12 记录持续被服务端目标授权拒绝 | 持续阻塞，不计作多次产品生成失败 | [H13](#h13)：只修既定目标，回读收件身份 |
| 报告分账和 flaky 解释 | 10/10 补充证据漏计；10/12 根因错派、flaky 被通过数掩盖 | 同类报告判据反复出现；不同 defectId 不归并成同因复发 | [H12](#h12)：首次失败、稳定通过、未执行分开 |
| 运行版本和元数据 | 10/08 版本等价误判；10/10 真正版本账本不一致，后记录已验证 | 是不同根因，不是一次修复被重复算失败 | [H14](#h14)：工具版本、实际业务版本分开 |

长期敏感项仍包括默认白桃生图、JPEG/多图引用、画布进度与文件夹并发。近期没出现不表示历史遗忘；其方法入口仍保留在核心清单中。

## H01

**主题：模型目录、默认项与实际执行不一致。** 关联 F12、F14、F16、F17、F23。

历史问题：选择器暴露默认池，推荐型号与实际调用不符；旧展示名代替运行时稳定标识；不支持的参数让纯文字白桃请求被拒绝。原台账分别记有已定位的模型契约、配置权威和目录身份问题，不按“生图失败”合并成一个根因。

经验：模型健康与 HTTP 200 不证明生成成功。必须从默认页面选择、持久任务、实际网关执行一路关联到可下载解码的图片，明确任何配置降级。10/10 记录有 CDS 真实白桃、尺寸和 JPEG 通过，不能据此关闭未完成的正式环境复验。

下次必验：[F17](guide.platform.core-business-acceptance.md#f17)、[F23](guide.platform.core-business-acceptance.md#f23)。依据 REG-visual-model-contract-001、REG-visual-policy-001、REG-model-catalog-identity-001；完整原记录见下方索引。

## H02

**主题：JPEG 格式、引用数量与多图语义。** 关联 F18、F21、F22。

历史问题：JPEG 被声明为 PNG；图片模型误走聊天协议；地址拼接导致 HTML 200 被当模型响应；新增数量契约后，巡检旧请求没有同步。前三类归原协议/配置记录，最后一类有明确测试用例缺陷 DEF-STSMK-TEST-002，不能都归产品生图缺陷。

经验：保留真实图片字节及声明，核对选中、持久化和结构化出站数量，证明主路是参考图生成；合法产物还要验证每张图的指定特征。缺参数、丢引用应在上游调用前拒绝。10/10 原失败曾扇出 13 个 caseId，但仍是一个原始契约故障事件。

下次必验：[F18](guide.platform.core-business-acceptance.md#f18)、[F21](guide.platform.core-business-acceptance.md#f21)、[F22](guide.platform.core-business-acceptance.md#f22)。依据 REG-image-input-001、REG-image-reference-count-001、REG-multi-image-001、REG-multi-image-002；缺陷原状态与修复来源保留在下方索引。

## H03

**主题：缩放、触控与局部主题不能被入口截图证明。** 关联 F02、F05、F07、F08、F19、F20。

历史问题：进度在缩放后出屏或裁切；坐标换算错误；移动 CDS 小部件挡操作；10/08 录音局部主题测量曾被页面根节点的暗色状态掩盖。原记录已给出不同的坐标和主题选择器原因，不用“移动端不好用”替代诊断。

经验：在方、横、竖图的执行中取证，验证真实可见区域；触控环境必须实际触控。测量目标面板自身状态，不只量页面根节点。局部主题修复记录提交为 `70f199ac183f3c5d8cfe1ad544f1a435f8c9e273`，本册不追加新关闭结论。

下次必验：[F19](guide.platform.core-business-acceptance.md#f19)，并对录音/文件的运行阶段复读；依据 REG-visual-progress-001、REG-visual-progress-002、REG-visual-viewport-001、REG-cds-widget-mobile-001。

## H04

**主题：真实转写与 ASR 路由。** 关联 F05、F06、F07、F10。

历史问题：ASR 额度不足，以及业务仍读取旧配置权威使真实转写失败。原因来自 REG-asr-routing-001 的历史诊断，不推断它仍是当前环境故障。

经验：短音频必须得到匹配原文并保存、重开；核对实际 ASR 调用，不能以健康状态、空条目或音频上传成功代替。停止与恢复也必须围绕同一任务。

下次必验：[F05](guide.platform.core-business-acceptance.md#f05)、[F06](guide.platform.core-business-acceptance.md#f06)，清理录音、条目及分片后回读。

## H05

**主题：文件解析假成功与假上传进度。** 关联 F08、F09。

历史问题：损坏文件解析失败却保存为空正文；10/08 另发现字节传完后，解析阶段仍长期显示“正在上传 99%”。这是产物判据和阶段反馈两个不同问题。

经验：固定标题、正文或表格基准决定解析是否正确；上传完成后应进入解析反馈，下载字节也要验证。99% 阶段修复来源为 `72324cf75f3fc0e7c8eb433eb7c102e4dfc9bbaa`；原损坏样本依据 REG-file-001，正式不主动上传损坏文件。

下次必验：[F08](guide.platform.core-business-acceptance.md#f08)、[F09](guide.platform.core-business-acceptance.md#f09)。

## H06

**主题：视频有任务、有文件，不等于用户能播放。** 关联 F12、F13。

历史问题：下载地址需要上游鉴权；10/08 记录还出现后台任务跨部署被错误 worker 消费及 CDS 路由指向不可用供应能力。后两项按来源记录分别处理，不据此宣称某供应商现在全局不可用。

经验：任务归属、同源可下载字节和 MP4 解码各自留证。来源记录 `0123316d95d299ad9c5da7c50b2a1cefc56dd718` 与当日 VIDEO-004 CDS 定向通过仅证明对应修复范围，不能替代正式成片。

下次必验：[F12](guide.platform.core-business-acceptance.md#f12)、[F13](guide.platform.core-business-acceptance.md#f13)，依据 REG-video-001。

## H07

**主题：文件夹身份、名称占用与拖拽归属。** 关联 F25、F26、F29。

历史问题：空文件夹不持久、拖拽高亮太弱；大小写/Unicode 名称被错误合并；过期锁或历史快照覆盖新映射；创建撞上重命名窗口返回旧名称实体。四类机制分开守卫。

经验：真实拖拽取证＋刷新归属回读＋隔离持久化时序夹具缺一不可。10/10 来源记录三个固定 REG 的 CDS 通过，但正式安全复验和后续平台清理问题仍独立记录。

下次必验：[F25](guide.platform.core-business-acceptance.md#f25)、[F26](guide.platform.core-business-acceptance.md#f26)、[F29](guide.platform.core-business-acceptance.md#f29)。依据四条 REG-web-folder-* 原记录，过期租约不在正式注入。

## H08

**主题：分享同页锚点误跳对象存储目录。** 关联 F27。

历史问题：srcDoc 的相对资源基址使纯片段链接被解析为目录请求，出现缺文件错误；原记录已经定位这一机制。

经验：必须真实点击链接并核对 frame 地址、滚动和网络，而不是直接滚到目标。业务分享页与验收报告查看器是不同入口，修好其中一个不证明另一个也通过。

下次必验：[F27](guide.platform.core-business-acceptance.md#f27)，依据 REG-web-share-anchor-001。

## H09

**主题：向我提问的正文来源和流式解析。** 关联 F28。

历史问题：迁移存储后读取不到旧正文；临时测试把 typing 帧当业务答案，旧解析器还会吞损坏帧。分别属于正文回退与测试解析，不能都派给模型质量负责人。

经验：正文写入唯一事实，页面真实提问需显示 phase/typing/done 且答中事实；存量样本单独回读，不查真实旧站点。原记录为 REG-web-ask-content-001、REG-web-ask-stream-001。

下次必验：[F28](guide.platform.core-business-acceptance.md#f28)，缺存量合法夹具时留为未测。

## H10

**主题：专用身份和正常导航，不能用管理员替代。** 关联 F01、F02、F03、F04、F24。

历史问题：凭据漂移、会话错误误分类、专用角色缺租户权限；页面已注册但搜索/移动导航找不到；知识库首操作入口不稳定。前几项有来源诊断，知识库入口根因仍待复现，不能强行归到同一鉴权原因。

经验：业务前先核对专用身份，缺权限写监控未执行并恢复原身份；正常导航与直接请求分别验证，不切通用管理员。DEF-STSMK-GATEWAY-001 的独立关闭记录未在最新材料中明确，后续网关用例通过不能替它补写 verified。

下次必验：[F01](guide.platform.core-business-acceptance.md#f01)、[F02](guide.platform.core-business-acceptance.md#f02)，完整身份类 REG 见原记录索引。

## H11

**主题：首轮平台抖动与清理证明。** 关联 F20、F24 至 F30。

10/12 原缺陷 DEF-STSMK-CDS-WEB-FLAKY-001 为 open：首轮静态资源 502、控制面 504，重试通过但 COMMON-004 无法证明首次资源零残留，负责人是 CDS/运行平台。底层抖动根因仍未知；“宿主过载或超时窗口使请求后台继续”只是推测，不当作已确认产品根因。

另有三个不同记录：网页测试隔离框架异常曾未使判据变红；合法后台处理超过客户端清理预算被误判；网关故障夹具硬中断留配置注入态。不能用增加超时或第二次成功同时关闭它们。10/10 图片下载 TLS 断连是单次 flaky 记录，近期复发次数尚不足。

经验：首轮失败资源账单独保留，重试后仍追踪第一次创建；清理按请求完成与持久回读判定。只清本轮合法归属资源；故障注入残留只能在原授权范围恢复，不扩大配置权限。

下次必验：[F30](guide.platform.core-business-acceptance.md#f30)与[候选 C01](guide.platform.core-business-acceptance.md#c01)。来源：[10/12 最终历史报告](https://miduo.org/reports?project=prd-agent&folder=e525bc9663c8449793b950808860982e&report=494bf05258d542489f37eb8973bc687f)；来源 memory 记载当时 verify-open 通过，本次没有重新做验真。

## H12

**主题：报告、视觉和通过分母的证明边界。** 关联全部 F，重点 F31。

历史问题：未执行却被写成原则性通过；代表图冒充全部状态；默认简版隐藏字段后被误判缺正文；漏计补充证据；10/12 把平台清理失败错派知识库且没有单列 flaky。它们是不同的验收链或报告判据缺陷，不是所有业务都坏。

经验：稳定通过、flaky、失败、未执行分列；原失败和每个计数均可追到原 case。按环境分账，图片只证明实际对应状态。DEF-STSMK-REPORT-003 来源登记 verified，修复 ref 为 `868ac22bdf58d4054a1e50a14e8b580fe3c2c7ab`、`823fc7b47792525ff3938688caf5de4eb2b81402`，不据此关闭另一个 REPORT-002。

下次必验：线上归档、正文回读与真实锚点点击；原记录见报告类 REG 索引。来源：[10/10 历史结果](https://miduo.org/reports?project=prd-agent&folder=e525bc9663c8449793b950808860982e&report=5467301cc06844b29e732971aaaea990)、[10/12 纠偏后历史报告](https://miduo.org/reports?project=prd-agent&folder=e525bc9663c8449793b950808860982e&report=494bf05258d542489f37eb8973bc687f)，仅作历史引用。

## H13

**主题：固定用户通知持续阻塞。** 关联 F31。

DEF-STSMK-NOTIFY-001 在 10/08、10/10、10/12 的记录里持续 blocked，最新严重度 P2。已知的是服务端拒绝固定目标授权，10/09 曾核对目标用户名配置漂移；当前用户名、固定身份绑定和实际授权是否都修好须复验，不能只凭改了一处配置推断送达。

经验：通知不是核心业务执行授权，也不应取代无报告的验收交付。唯一恢复动作是管理员修复既定单一目标绑定，然后以原 runId 与已验真报告补发、回读 targetUserId 和收件状态；不要求用户重复授权，不改投他人或全局，不用 Slack。

下次必验：[F31](guide.platform.core-business-acceptance.md#f31)，依据 REG-stsmk-notify-evidence-001 和[10/12 历史报告](https://miduo.org/reports?project=prd-agent&folder=e525bc9663c8449793b950808860982e&report=494bf05258d542489f37eb8973bc687f)。

## H14

**主题：执行器覆盖、版本门禁与产品故障必须分开。** 关联全部 F。

历史问题：正式只读先被无用网关依赖/零视觉报告挡住；工具提交误当业务版本不一致；暂停后部署复用旧元数据；未接入用例被算产品失败。10/10 图片请求旧夹具扇出多个红项，属于测试契约缺陷。正式基础检查先行只证明基础，不代表正式生成已测。

经验：固定的是本轮证明事实，不要求正式功能先发布；工具与实际部署版本分开记。清单覆盖与运行执行分开审计，改报告不能补足真实业务断言。INFRA-002/004 和 TEST-003 在来源中有 verified 记录；部分旧 ID 缺独立关闭映射，不能重新编号或删除。

下次必验：读取当前真实版本与冻结计划、精确筛选、逐项回读，沿原 case 定向复验。修复来源为[已有质量闭环 PR #1670](https://github.com/inernoro/prd_agent/pull/1670)；本次只引用，不改变 PR 或发布状态。

## H15

**主题：输入、用户错误、教程和头像的可读性。** 关联 F02、F11 及各模块错误路径。

历史问题：普通文字被短视频入口排队；原上游错误泄漏到用户页面；教程乐观关闭却未保存；默认头像大图失效。原记录分别定位了输入前置校验、错误分层、空进度兼容和资源兜底，不共享一个修复结论。

经验：错误必须说明结果与恢复动作；非法输入不得创建幽灵任务；教程必须刷新回读；资源失败不能只看页面外壳。下次按[原方法](guide.platform.core-business-acceptance.md#f02)和[F11](guide.platform.core-business-acceptance.md#f11)复验，细节见相应原记录。

## 缺陷原编号与最后明确状态

以下为读取来源中的最后明确登记，不是本次变更状态。旧 ID 后续整体关闭信息不全时继续核对；上方按主题归档不删除这些原身份。

| 原 defectId | 最后明确登记 | 历史主题 | 仍须留意什么 |
|---|---|---|---|
| DEF-STSMK-INFRA-001 | blocked，10/08 | [H14](#h14) | 后续版本等价修复存在，但该 ID 独立关闭映射待核对 |
| DEF-STSMK-GATEWAY-001 | blocked，10/08 | [H10](#h10) | 专用网关身份独立关闭记录待核对 |
| DEF-STSMK-CHAIN-001 | fix-in-progress，10/08 | [H12](#h12) | 后续报告链可交付不自动补写原 ID 关闭 |
| DEF-STSMK-NOTIFY-001 | blocked，10/12 | [H13](#h13) | 既定单一目标授权与收件回读 |
| DEF-STSMK-TEST-002 | fixed-pending-full-regression，10/10 | [H02](#h02) | 正式复验不能由 CDS 通过代替 |
| DEF-STSMK-INFRA-002 | verified，10/12 | [H14](#h14) | 保留版本漂移失败、修复与通过来源 |
| DEF-STSMK-TEST-003 | verified，10/10 | [H12](#h12) | 跨版本旧证据不能继续混用 |
| DEF-STSMK-TEST-004 | fix-in-progress，10/10 | [H14](#h14) | 10/12 已确认相关覆盖，整体原 ID 关闭映射待核对；当前 COMMON-004 是平台问题 |
| DEF-STSMK-REPORT-002 | fixed-pending-full-regression，10/10 | [H12](#h12) | 补充证据分母独立核对 |
| DEF-STSMK-REPORT-003 | verified，10/12 | [H12](#h12) | 保留错派、漏 flaky 与纠偏记录 |
| DEF-STSMK-INFRA-004 | verified，10/12 | [H14](#h14) | 读取材料未给完整首因卡，仍留资料缺口，不逆推根因 |
| DEF-STSMK-CDS-WEB-FLAKY-001 | open，10/12 | [H11](#h11) | 首轮稳定、全部相关 REG 与零残留同时成立 |

## 原始历史索引

本次纳入主干 34 条 REG 与修复分支新增 8 条，共 42 个唯一原编号。这里是全部**已纳入来源**的索引，不承诺穷尽未登记事故。主干与修复分支登记状态有差异时同时保留；active/candidate 不是缺陷关闭状态。下面的“原记录”是固定提交的台账行，包含夹具、旧证据、环境策略与重复字段，可按需回看。

主干来源提交为 `45533b419e1cfc54b145a545a716563617659d01`；修复分支来源提交为 `823fc7b47792525ff3938688caf5de4eb2b81402`。近期事实另来自自动化 memory 截至 2026-10-12 14:50 的日期检查点，不把顶部旧摘要当最终状态。原报告和 PR 都是历史来源，本次未重新 verify-open、未证明当前线上通过、未改任何缺陷状态。

| 原 REG 编号 | 原问题摘要 | 首次登记 | 回归登记状态（不是缺陷状态） | 经验主题 | 历史原始记录 |
|---|---|---|---|---|---|
| REG-model-catalog-identity-001 | 展示名与运行标识不一致，后续发布覆盖止血 | 2026-09-21 | 主干/修复分支：candidate | [H01](#h01) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L51) |
| REG-visual-model-contract-001 | 默认池推荐与实际模型不符、白桃参数被拒绝 | 2026-08-31 | 主干/修复分支：active | [H01](#h01) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L35) |
| REG-visual-policy-001 | 业务开放目录与默认配置失去唯一权威 | 2026-08-31 | 主干/修复分支：active | [H01](#h01) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L67) |
| REG-image-input-001 | JPEG 被错标为 PNG | 2026-08-30 | 主干/修复分支：candidate | [H02](#h02) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L29) |
| REG-image-reference-count-001 | 新增引用数量契约，巡检旧请求未同步 | 2026-10-09 | 主干/修复分支：active | [H02](#h02) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L52) |
| REG-multi-image-001 | 图片模型误走聊天协议 | 2026-08-02 | 主干/修复分支：active | [H02](#h02) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L15) |
| REG-multi-image-002 | 地址拼接错误，HTML 200 被当模型结果 | 2026-08-02 | 主干/修复分支：active | [H02](#h02) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L16) |
| REG-cds-widget-mobile-001 | CDS 移动徽章遮挡操作 | 2026-09-14 | 主干/修复分支：candidate | [H03](#h03) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L48) |
| REG-visual-progress-001 | 多比例和移动进度被裁切 | 2026-08-04 | 主干/修复分支：candidate | [H03](#h03) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L26) |
| REG-visual-progress-002 | 缩放坐标计算使进度行越界 | 2026-09-14 | 主干/修复分支：active | [H03](#h03) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L46) |
| REG-visual-viewport-001 | 放大时进度锚点移出视口 | 2026-08-31 | 主干/修复分支：active | [H03](#h03) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L36) |
| REG-asr-routing-001 | ASR 额度不足、实际路由仍读旧权威 | 2026-08-04 | 主干/修复分支：active | [H04](#h04) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L23) |
| REG-file-001 | 解析失败仍保存空正文 | 2026-08-04 | 主干/修复分支：active | [H05](#h05) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L19) |
| REG-video-001 | 上游鉴权地址使用户无法下载视频 | 2026-08-04 | 主干/修复分支：active | [H06](#h06) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L20) |
| REG-web-folder-canonical-001 | 名称等价键合并与 Unicode 区分错误 | 2026-09-04 | 主干：candidate；修复分支：active | [H07](#h07) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L41) |
| REG-web-folder-create-rename-001 | 创建撞重命名时提前返回旧名称 | 2026-09-04 | 主干：candidate；修复分支：active | [H07](#h07) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L43) |
| REG-web-folder-drop-001 | 空文件夹入口和持久化、拖拽提示不足 | 2026-09-01 | 主干/修复分支：candidate | [H07](#h07) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L40) |
| REG-web-folder-fence-001 | 过期操作或历史快照覆盖新映射 | 2026-09-04 | 主干：candidate；修复分支：active | [H07](#h07) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L42) |
| REG-web-share-anchor-001 | 纯片段链接跳到存储目录 | 2026-09-01 | 主干/修复分支：candidate | [H08](#h08) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L38) |
| REG-web-ask-content-001 | 迁移后的存量正文误判为空 | 2026-09-01 | 主干/修复分支：candidate | [H09](#h09) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L39) |
| REG-web-ask-stream-001 | 流式测试误拼 typing 帧、吞损坏帧 | 2026-10-05 | 修复分支：active（未入所读主干） | [H09](#h09) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L61) |
| REG-auth-diagnosis-001 | 凭据不匹配被笼统归为会话未授权 | 2026-09-01 | 主干/修复分支：active | [H10](#h10) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L30) |
| REG-auth-health-entry-001 | 注册页面却无法从正常导航发现 | 2026-09-01 | 主干/修复分支：active | [H10](#h10) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L31) |
| REG-auth-identity-permissions-001 | 巡检角色缺权限，业务被预先挡住 | 2026-09-14 | 主干/修复分支：active | [H10](#h10) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L45) |
| REG-auth-synthetic-001 | 巡检凭据漂移导致持续未执行 | 2026-09-01 | 主干/修复分支：active | [H10](#h10) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L68) |
| REG-document-store-action-001 | 知识库首操作入口不稳定，根因待确认 | 2026-08-04 | 主干/修复分支：candidate | [H10](#h10) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L24) |
| REG-llmgw-auth-001 | 部署快照未注入新的身份托管配置 | 2026-08-03 | 主干/修复分支：active | [H10](#h10) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L18) |
| REG-gateway-failover-fixture-001 | 单上游配置使切换用例无合法备用 | 2026-09-14 | 主干/修复分支：active | [H11](#h11) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L49) |
| REG-gateway-failover-fixture-002 | 硬中断留下故障注入配置 | 2026-09-15 | 主干/修复分支：active | [H11](#h11) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L50) |
| REG-web-cleanup-timeout-001 | 清理客户端预算短于合法后台处理 | 2026-10-12 | 修复分支：active（未入所读主干） | [H11](#h11) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L59) |
| REG-web-sandbox-001 | 隔离框架异常没有让原验收断言变红 | 2026-10-05 | 修复分支：active（未入所读主干） | [H11](#h11) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L58) |
| REG-stsmk-report-risk-001 | 未执行仍被写成通过、风险和分母混淆 | 2026-10-05 | 修复分支：active（未入所读主干） | [H12](#h12) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L56) |
| REG-stsmk-report-view-001 | 未展开完整报告就误判字段缺失 | 2026-10-05 | 修复分支：active（未入所读主干） | [H12](#h12) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L63) |
| REG-visual-evidence-001 | 代表图暗示未测状态全部通过 | 2026-08-04 | 主干/修复分支：active | [H12](#h12) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L27) |
| REG-stsmk-notify-evidence-001 | 没有已验真报告仍走通知路径 | 2026-10-05 | 修复分支：active（未入所读主干） | [H13](#h13) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L65) |
| REG-stsmk-cds-runtime-equivalence-001 | 工具提交误当业务版本差异 | 2026-10-08 | 修复分支：active（未入所读主干） | [H14](#h14) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L33) |
| REG-stsmk-production-read-only-001 | 只读任务被无用依赖和零视觉门禁误挡 | 2026-10-06 | 修复分支：active（未入所读主干） | [H14](#h14) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L32) |
| REG-avatar-asset-001 | 默认头像大图失败影响入口 | 2026-09-14 | 主干/修复分支：active | [H15](#h15) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L47) |
| REG-short-video-input-001 | 普通文字被作为视频链接创建任务 | 2026-08-04 | 主干/修复分支：active | [H15](#h15) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L25) |
| REG-tutorial-progress-001 | 教程乐观关闭却未持久完成 | 2026-08-04 | 主干/修复分支：active | [H15](#h15) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L22) |
| REG-user-error-001 | 系统告警泄漏底层错误且无恢复动作 | 2026-08-04 | 主干/修复分支：active | [H15](#h15) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L21) |
| REG-visual-error-001 | 生图错误原文泄漏到用户界面 | 2026-08-02 | 主干/修复分支：active | [H15](#h15) | [原记录](https://github.com/inernoro/prd_agent/blob/823fc7b47792525ff3938688caf5de4eb2b81402/.claude/skills/stable-smoke/reference/regression-ledger.md#L17) |
