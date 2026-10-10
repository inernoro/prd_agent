# MAP 核心功能验收清单 · 规格

> **版本**：v1.0 | **日期**：2026-10-10 | **状态**：草案（可复用清单，尚未填写本轮结果）

**一句话**：每 48 小时按这张表确认正式环境的重要产品功能是否能真正完成。
**谁该读**：产品负责人、业务负责人和验收执行者。
**读完能做什么**：看清要测哪些功能，点开对应验收方法，并逐行填写本轮结果。

## 怎么使用

本表是长期模板，不是验收报告，也没有预填任何通过结果。功能依据现有核心业务台账整理，不以页面数量、截图数量或接口存活代替产品功能，也不据此声称已经取得真实用户使用量统计。

1. 每轮保留一份新的评分表，不覆盖上一轮；先带入未关闭问题。
2. 正式环境是主体。直接检查当前线上功能，不要求先发布、指定分支或特定版本。
3. CDS 常规子集建议仅选 F01、F05、F08、F17、F18 五项。其余只在相关缺陷或修复验收时追加，CDS 不构成正式环境开测前置。
4. 编号长期保留。需要知道怎么操作时，点击该行“验收方法”；执行者也使用同一编号。
5. 正式环境中的轮换项先冻结本轮选中的子项；没有选中的子项不能声称通过。异常通知只在本轮出现异常且报告可交付后触发。

填写约定：`[ ]` 未执行；`[x] pass` 通过；`[!] fail` 失败；`[!] blocked` 阻塞；`[!] flaky` 首次失败、重试通过；`[-]` 本轮不安排。阻塞、不稳定和未执行都不能算通过。每个结果必须关联本轮证据，证据和清理要求见对应方法。

## 重要产品功能评分表

| 编号 | 模块 | 重要功能 | 什么结果才算可用 | 验收方法 | 正式结果 | CDS 结果 |
|---|---|---|---|---|---|---|
| F01 | 登录与访问 | 巡检身份登录、权限隔离 | 能进入应有页面，不能访问其他人的数据 | [F01](guide.platform.core-business-acceptance.md#f01) | [ ] | [ ] |
| F02 | 导航 | 从首页找到并进入业务 | 桌面和触控移动端均能通过正常导航进入 | [F02](guide.platform.core-business-acceptance.md#f02) | [ ] | [-] |
| F03 | 知识库 | 创建知识库与保存内容 | 创建后可见，内容属于正确知识库和身份 | [F03](guide.platform.core-business-acceptance.md#f03) | [ ] | [-] |
| F04 | 知识库 | 已保存内容刷新后仍可读 | 刷新、离开再进入后内容与归属不丢 | [F04](guide.platform.core-business-acceptance.md#f04) | [ ] | [-] |
| F05 | 录音 | 实时录音转笔记 | 能录音，能得到并保存真实转录原文 | [F05](guide.platform.core-business-acceptance.md#f05) | [ ] | [ ] |
| F06 | 录音 | 已有音频上传转笔记 | 上传有进度，转录内容与固定音频一致 | [F06](guide.platform.core-business-acceptance.md#f06) | [ ] | [-] |
| F07 | 录音 | 后台继续与中断恢复 | 关闭面板、刷新后能找回同一任务，不重复保存 | [F07](guide.platform.core-business-acceptance.md#f07) | [ ] | [-] |
| F08 | 文件解析 | 上传文档并得到可读内容 | 本轮两种格式都能解析，正文或表格符合样本 | [F08](guide.platform.core-business-acceptance.md#f08) | [ ] | [ ] |
| F09 | 文件解析 | 下载原件 | 文件名、类型和实际字节与上传原件一致 | [F09](guide.platform.core-business-acceptance.md#f09) | [ ] | [-] |
| F10 | 短视频解析 | 上传短视频并转写 | 得到真实字幕或转写，时间轴与视频时长一致 | [F10](guide.platform.core-business-acceptance.md#f10) | [ ] | [-] |
| F11 | 短视频解析 | 通过公开视频链接解析 | 合法链接产生结果，非法文字在创建任务前被拒绝 | [F11](guide.platform.core-business-acceptance.md#f11) | [ ] | [-] |
| F12 | 视频创作 | 从文字生成成片 | 脚本、分镜、关键帧到成片跑通，视频能播放 | [F12](guide.platform.core-business-acceptance.md#f12) | [ ] | [-] |
| F13 | 视频创作 | 刷新恢复与下载成片 | 刷新仍是原任务，下载后视频能解码和播放 | [F13](guide.platform.core-business-acceptance.md#f13) | [ ] | [-] |
| F14 | 文学创作 | 创作、保存与刷新回读 | 内容持续生成，保存后完整回读，不被截断 | [F14](guide.platform.core-business-acceptance.md#f14) | [ ] | [-] |
| F15 | 文学创作 | 停止续写、改写与扩写 | 本轮选中的操作正确，未选内容不被覆盖 | [F15](guide.platform.core-business-acceptance.md#f15) | [ ]（轮换） | [-] |
| F16 | 文学创作 | 为文章生成并插入配图 | 图片可读取，插入正确位置，刷新后仍在 | [F16](guide.platform.core-business-acceptance.md#f16) | [ ] | [-] |
| F17 | 视觉创作 | 默认模型文字生图 | 不手选模型，“白桃”真实生成可解码的 1024×1024 图片 | [F17](guide.platform.core-business-acceptance.md#f17) | [ ] | [ ] |
| F18 | 视觉创作 | JPEG 参考图生图 | 参考图确实送到图生图链路，不静默变成纯文字生图 | [F18](guide.platform.core-business-acceptance.md#f18) | [ ] | [ ] |
| F19 | 视觉创作 | 支持尺寸与画布缩放 | 支持的方形、横图、竖图尺寸正确，缩放后进度仍可读 | [F19](guide.platform.core-business-acceptance.md#f19) | [ ] | [-] |
| F20 | 视觉创作 | 下载、重试与刷新恢复 | 图片可下载；刷新保留结果；本轮选测重试不丢旧输入 | [F20](guide.platform.core-business-acceptance.md#f20) | [ ] | [-] |
| F21 | 多图视觉 | 两张参考图组合生成 | 两张图都进入请求，结果能证明两张图均起作用 | [F21](guide.platform.core-business-acceptance.md#f21) | [ ] | [-] |
| F22 | 多图视觉 | 三图组合、重排与删除 | 本轮选测子项的数量、顺序和结果与界面一致 | [F22](guide.platform.core-business-acceptance.md#f22) | [ ]（轮换） | [-] |
| F23 | 模型治理 | 选择模型与实际执行一致 | 默认与推荐一致，选中的模型能被任务与调用日志证实 | [F23](guide.platform.core-business-acceptance.md#f23) | [ ] | [-] |
| F24 | 网页托管 | 正常进入托管主控台 | 个人空间、分组、站点卡和分享操作可用 | [F24](guide.platform.core-business-acceptance.md#f24) | [ ] | [-] |
| F25 | 网页托管 | 创建空文件夹 | 创建后立即出现，刷新不丢，同名身份不重复 | [F25](guide.platform.core-business-acceptance.md#f25) | [ ] | [-] |
| F26 | 网页托管 | 真实拖拽站点归档 | 目标强高亮并显示“松开移入”，归属刷新后仍正确 | [F26](guide.platform.core-business-acceptance.md#f26) | [ ] | [-] |
| F27 | 网页分享 | 点击分享页同页锚点 | 在当前页面内定位，不跳到存储目录或出现缺文件错误 | [F27](guide.platform.core-business-acceptance.md#f27) | [ ] | [-] |
| F28 | 网页分享 | 向页面正文提问 | 有阶段反馈，回答能正确引用页面的固定正文内容 | [F28](guide.platform.core-business-acceptance.md#f28) | [ ] | [-] |
| F29 | 网页托管 | 并发创建、重命名与名称唯一 | 只有一个有效同名身份，不返回旧名称，不被过期操作覆盖 | [F29](guide.platform.core-business-acceptance.md#f29) | [ ] | [-] |
| F30 | 网页托管 | 撤销分享与删除资源 | 分享撤销后不可访问，站点和文件夹删除后无残留 | [F30](guide.platform.core-business-acceptance.md#f30) | [ ] | [-] |
| F31 | 站内通知 | 将异常报告定向通知负责人 | 只有配置用户收到通知，打开的是已验真的线上报告 | [F31](guide.platform.core-business-acceptance.md#f31) | [-]（异常时） | [-] |

## 每轮结果怎么留下来

执行者将本表复制进本轮 CDS 线上报告，并填入：轮次、时间、环境、实际部署版本、每行结果、最相关证据和未通过原因。记录实际部署版本是为了追踪，不是要求发布或必须取得某个指定版本。

每行可以覆盖多个原用例。只有本轮选定的子项全部通过、产物合格、证据完整且资源清理回读通过，才可填写 `pass`；没有跑的子项必须单列，不可用一张入口截图替代。正式与 CDS 分开填写，不能用 CDS 成功代替正式成功。

旧问题继续使用原缺陷编号和原用例编号；新问题追加，不重新编号，不删除历史。下一轮先复验这些未关闭问题。

本文件和[验收方法](guide.platform.core-business-acceptance.md)是长期模板。每轮报告、截图和结果只归档到 CDS 验收中心，不能把这两份本地 Markdown 当作验收已经完成。
