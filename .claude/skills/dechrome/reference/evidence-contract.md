# 页面账本与证据契约

账本为UTF-8 JSON，schema v2。校验成功只表示声明满足结构与所选门槛，不能代替人工证据审查或生成“治理完成”结论。

## 目录

- [范围、状态与统计](#范围状态与统计)
- [来源和真实路径](#来源和真实路径)
- [修复的同条件比较](#修复的同条件比较)
- [必须证明的效果](#必须证明的效果)
- [截图、报告与图片身份](#截图报告与图片身份)
- [迁移与执行](#迁移与执行)

## 范围、状态与统计

`scope` 在开测前根据路由、导航与权限盘点，独立于 `cases`。每个实际页面/二级视图一行，别名写入 `aliases`，不重复计数。与原始路由清单人工核对，禁止删掉受阻页面凑绿。

```json
{
  "schema_version": 2,
  "target_revision": "待验收部署提交或精确产物标识",
  "scope": [{
    "id": "upstreams/providers",
    "route": "/platforms?view=provider",
    "goal": "定位上游与读取连接状态",
    "frequency": "运维高频推断，未取得遥测",
    "core_action": "筛选上游并打开连接详情",
    "required_states": ["default", "tabs", "expanded", "empty", "few", "many", "loading", "error", "readonly", "desktop-light", "desktop-dark", "narrow-light", "narrow-dark"]
  }],
  "cases": [{
    "page": "upstreams/providers", "state": "default", "decision": "retained",
    "reason": "连接排障要同时读取错误与权限，详情工作区的必要状态应持续可读",
    "retention": {
      "task": "核对连接失败原因后决定是否修改上游",
      "necessary_space_or_status": "连接错误、权限范围与恢复操作是该任务必要内容，未造成无意义滚动",
      "observation_reference": "provider-default.png"
    },
    "evidence": [{"provenance": "preview-live", "reference": "provider-default.png", "revision": "实际观测版本"}],
    "checks": [{"assertion": "错误和权限完整可读，恢复入口可键盘到达", "outcome": "pass"}]
  }]
}
```

示例只给一个状态，检查器会报告其余缺失。每个 `required_states` 都要有case；同一融合旅程可覆盖多个状态，不必重复运行相同浏览器路径。

十三个标准状态不得省略：默认、二级标签、展开、空态、少量、大量、加载、错误、只读、桌面明暗、窄屏明暗。不适用必须给理由，例如固定登录表单没有多记录数量；无账号、无数据、未制造故障应记 `blocked`，不能写N/A。长正文边界不能仅以“不是多记录表格”免测。

| decision | 允许表达的结论 |
|---|---|
| `fixed` | 此case有已证明的目标行为改善与任务收益，含完整比较及verified_effect；不等于整个页面已治理 |
| `retained` | 人工按具体任务保留必要空间/状态，含retention与实页证据；打开过或缺证不是保留理由 |
| `minor-change` | 确有局部调整但不足以证明治理目标，保留改动记录，不计fixed或治理完成 |
| `blocked` | 未验收/待证/问题未解决，必须写具体blocker和恢复条件 |
| `not-applicable` | 此状态确实不适用，并解释原因 |

盘点表面数、实际观察数、不同URL数、共享影响面、微改数、已证明收益和真实验收数分别报告。检查器的计数单位是页面状态格，不是“已治理页面”；不因每页没有diff而判失败，也不把共享使用方全部计作已修。

## 来源和真实路径

证据 `provenance` 只允许：`deterministic-fixture`（合成数据的界面状态）、`preview-live`（同提交正常登录/导航的真实预览）、`integration-live`（实际外部服务/持久化结果）。三者不能互换。

`reference` 为交接工件路径或报告链接，禁止凭据/会话/私有配置。`revision` 是实际观察的提交或精确构建身份；产品身份未知时不能拿测试脚本SHA冒充。旧main截图只作基线，不证明新source。

构建与冻结产物必须有依赖约束：前一步退出码非0就停止，不得继续复制仍存在的旧dist。仅在构建成功后记录源码文件摘要和构建产物摘要，再运行浏览器；有未提交源码时同时记录实际文件身份，不能把HEAD当作整个源码身份。已发现构建失败后误用旧目录的取证应保留失败记录并作废，重新构建与取证，不将其算成新布局失败或通过。

`--require-live` 要求顶层 `target_revision`，所有非受阻、非不适用case都须有此版本的live证据，比较after也须匹配。旧preview+新fixture不能过新版真实验收门。`--require-complete` 拒绝blocked、失败断言和只能证明微改的case；两者都不能代替人工检查引用真实性。

## 修复的同条件比较

每个 `fixed` 必须有 `comparison`，双方记录实际状态及初始滚动位置，不允许缺值时填0。

```json
{
  "comparison": {
    "before": {"revision":"old","dataset":"two-v1","viewport":[390,844],"theme":"dark","role":"owner","state":"few-providers","scroll":{"document":[0,0],"local":{"pane":[0,0]}},"first_data_y":509,"unnecessary_before_px":80,"task_scroll_px":110,"task_steps":3},
    "after": {"revision":"new","dataset":"two-v1","viewport":[390,844],"theme":"dark","role":"owner","state":"few-providers","scroll":{"document":[0,0],"local":{"pane":[0,0]}},"first_data_y":406,"unnecessary_before_px":0,"task_scroll_px":0,"task_steps":3},
    "old_failure":"同一断言旧版失败的命令/输出入口",
    "new_pass":"同一断言新版通过的命令/输出入口",
    "nonessential_reason":"重复安装说明延迟查记录；权限提示必要且保留",
    "target":"首记录提前，字号/热区与主要操作保持"
  },
  "verified_effect": {
    "type":"metric","target":"first_content_y","unit":"px","direction":"decrease",
    "before":509,"after":406,"state":"few-providers",
    "assertion":"相同记录在不缩字和热区的情况下提前出现",
    "reference":"comparison-results.json",
    "task_benefit":"定位供应方不再先跨过重复安装说明"
  }
}
```

`dataset`、`viewport`、`theme`、`role`、`state`、`scroll`必须一致。`scroll.document`是 `[x,y]`；`scroll.local`按稳定工作区名称记录每个局部滚动器的 `[x,y]`，没有局部滚动器时用空对象。不要把完成任务后的滚动位置当初始对照位置。

锁定字体与加载完成点，等待动画稳定。`first_data_y`相对同一视口；空态测首个有效引导并说明对象。非必要高度要逐块解释，不是把数据前所有内容算多余。`task_scroll_px`为实际路径累计滚动（含局部），不能用最小几何距离冒充；步骤须有明确起止。

可见性不能只看非零边界框：关闭的原生折叠子孙也可能有几何值。检查实际渲染/折叠状态、视口、裁剪祖先与命中点；自动滚动能点击不等于原本没有裁切。

## 必须证明的效果

`verified_effect` 是一个主要目标效果对象，必须有 `type`、`target`、`before`、`after`、`state`、可观察 `assertion`、已列入case evidence的 `reference`、具体 `task_benefit`。其state必须匹配比较状态；同值或class/source变化不接受。

| type | target | 额外字段与方向 |
|---|---|---|
| metric | `first_content_y`、`primary_action_y`、`nonessential_before_px`、`actual_task_scroll_px`、`empty_scaffold_px` | unit=`px`，direction=`decrease` |
| metric | `task_steps` | unit=`steps`，direction=`decrease` |
| metric | `usable_workspace_px` | unit=`px`，direction=`increase` |
| boolean | `primary_action_visible`、`key_content_visible`、`necessary_state_visible`、`last_item_reachable` | 必须false→true |
| boolean | `transient_feedback_visible`、`content_obscured`、`content_overflow` | 必须true→false |

指标须为有限非负数字；`first_content_y`、`nonessential_before_px`、`actual_task_scroll_px`、`task_steps`必须与comparison中的对应值一致。其他目标由实际执行证据支撑，不能把CSS类有无重命名成可见性。新目标需先定义可观察契约，不以随意字符串绕过检查。

数字改变仍不自动证明收益显著。局部微改、删除表尾边框但核心内容/任务没有变化时，记minor-change或证据不足，不能包装成全页治理。没有统一像素/面积阈值；由任务解释变化是否有意义。

反馈修复可以让默认几何全部不变：以“成功后第7秒”为双方state，目标 `transient_feedback_visible` true→false，引用实际触发后的截图与时间线，并证明失败仍持续可读。默认截图相同不能证明此修复，也不能自动判它无效；不能冒称默认布局变紧凑。

## 截图、报告与图片身份

每组前后图同数据、同状态、同视口、同滚动，说明要比较什么。只变反馈就展示反馈状态；只变展开层就展示展开层。逐组写“改变了什么、什么未变、什么尚未证明”，不可只给两张缩略图让人找不同。

报告必须支持可读原图缩放/打开原尺寸及前后切换；缩略图只作索引。发布后从实际报告加载的图片取内容，核对源图与响应的SHA-256；若经过转码，改核解码内容并人工匹配目标区域。非零字节、naturalWidth>0只证明可加载，不证明图对、顺序对或状态对。

不同图片字节不证明可用性改善，相同默认图也不自动否定功能修复。图片身份检查与任务效果检查各自给结论，不使用像素变化比例代替UX判断。真实敏感原图留私有，公开报告优先合成数据，不擅自裁掉核心内容造成假紧凑。

## 迁移与执行

v1账本直接拒绝，禁止只改schema数字或把fixed改retained凑绿。逐项补齐同状态/滚动比较、verified_effect及任务证据；无法补齐者保留sourceFix事实并降级blocked或minor-change。保留结论须重审retention依据。

```bash
python3 scripts/check_ledger.py /path/to/ledger-v2.json
python3 scripts/check_ledger.py /path/to/ledger-v2.json --require-live --require-complete
```

退出0仅表示声明满足字段与所选门槛；退出1表示缺项/违规。脚本不抓取链接、不看截图、不裁定UX，也不保证调用方诚实；原始证据和人工复核仍是结论依据。

## 对照报告的默认阅读与原图路径

默认直接显示前后图，阅读差异需要0次模式切换；每张图一次激活直接打开对应100%原图，不能先选阶段再放大。完整原PNG字节不变，前后维持相同显示尺度。宽屏竖图对齐并排，宽截图及窄屏上下自然排布；不用固定高灰框撑满，也不把宽图缩成难读缩略图。

可用 `scripts/render_comparisons.py` 的 `render_comparisons(comparisons)` 复用正文、manifest、STYLE与SCRIPT；输入仍使用before/after PNG及change/unchanged/scope/versions和明确合成provenance，不将实际私有截图混入公开报告。可选display_title与summary只精简展示，完整口径保留。报告的视觉规范以宿主仓库为准。

浏览器执行：安装现有项目的Playwright，设DECHROME_PLAYWRIGHT_MODULE为其模块入口（缺省playwright），按环境设CHROMIUM_PATH，然后运行 `node tests/report_layout_smoke.mjs <报告URL>`。该检查验证默认双图、同尺度、排布、一步原图、Esc和焦点恢复及文档溢出；不替代截图审美检查、发布后的图片身份核对或业务验收。
