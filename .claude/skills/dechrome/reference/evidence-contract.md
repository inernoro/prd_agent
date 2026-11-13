# 页面账本与证据契约

账本是一份 UTF-8 JSON。它记录人工决策和原始证据入口；校验成功只表示字段、范围和同条件比较完整，不代表页面验收通过。

## 范围与状态

`scope` 在开测前根据实际路由、导航和权限盘点，独立于 `cases`。每个唯一页面/二级视图一行；实际详情页需用可访问对象进入。别名写入 `aliases`，不重复计数。与原始路由清单人工核对，避免从范围中删除受阻页面使检查变绿。

```json
{
  "schema_version": 1,
  "target_revision": "待验收部署提交",
  "scope": [{
    "id": "upstreams/providers",
    "route": "/platforms?view=providers",
    "goal": "定位上游与查看连接状态",
    "frequency": "高；根据运维日常任务推断，未取得遥测",
    "core_action": "筛选上游并打开连接详情",
    "required_states": ["default", "tabs", "expanded", "empty", "few", "many", "loading", "error", "readonly", "desktop-light", "desktop-dark", "narrow-light", "narrow-dark"]
  }],
  "cases": [{
    "page": "upstreams/providers",
    "state": "default",
    "decision": "retained",
    "reason": "此处必须显式给出人工检查后的保留理由，不能仅写正常",
    "evidence": [{
      "provenance": "preview-live",
      "reference": "evidence/provider-default.png",
      "revision": "部署版本或可追溯构建标识"
    }],
    "checks": [{"assertion": "筛选后可打开目标上游的连接详情", "outcome": "pass"}]
  }]
}
```

上面只有一个状态，故账本检查会指出其余状态缺失。每个 `required_states` 必须有对应 case；一个融合旅程可以提供多个状态的证据，不要求每格单独跑一次浏览器。

标准状态集合不得省略：默认、二级标签、展开、空态、少量、大量、加载、错误、只读、桌面明暗、窄屏明暗。确实不适用时提交 `not-applicable` case 和理由。例如纯登录表单没有记录数量；不能以“无测试账号”当不适用，应记 `blocked`。

`decision`：`fixed` 已改且有对比、`retained` 检查后保留、`blocked` 未验收、`not-applicable` 状态不适用。出现新问题但未修时用 `blocked` 并在理由与交接中说明待修项；不要伪装为保留。检查结果 `outcome` 为 `pass`、`fail` 或 `blocked`。

## 来源和真实路径

证据 `provenance` 只能是：

- `deterministic-fixture`：合成/注入数据，只证明指定界面状态、布局和操作断言。
- `preview-live`：同提交真实预览，正常登录与导航，核心操作实际执行。
- `integration-live`：实际外部服务与持久化结果；不能用前两者替代。

`reference` 是可访问的报告链接或交接中的相对工件路径；不放凭据、会话和私有配置。`revision` 记录实际观测版本，不用期望部署版本代替。`blocked` 需要 `reason` 与 `blocker`（具体失败及恢复条件），可附失败入口证据。`not-applicable` 不需要证据，但必须有可解释理由。

`--require-live` 要求顶层声明 `target_revision`；所有非受阻、非不适用 case 至少有该版本的真实预览或真实集成证据，修复对照的 after 也必须是该版本。旧版本真实截图不能搭配新版夹具冒充新版真实验收；否则仍可检查确定性账本，但不能标为真实验收齐备。`--require-complete` 拒绝受阻和失败断言。二者一起使用才是完整真实验收的字段门槛；仍须人工查证引用和判定。

## 修复的前后比较

每个 `fixed` case 必须含 `comparison`：

```json
{
  "comparison": {
    "before": {"revision": "old-sha", "dataset": "providers-two-v1", "viewport": [390,844], "theme": "dark", "role": "owner", "first_data_y": 509, "unnecessary_before_px": 80, "task_scroll_px": 110, "task_steps": 3},
    "after": {"revision": "new-sha", "dataset": "providers-two-v1", "viewport": [390,844], "theme": "dark", "role": "owner", "first_data_y": 406, "unnecessary_before_px": 0, "task_scroll_px": 0, "task_steps": 3},
    "old_failure": "同一关键数据可见性断言在旧版失败；附断言命令与失败输出入口",
    "new_pass": "同一断言在新版通过；附输出入口",
    "nonessential_reason": "逐块说明重复维护卡如何延迟数据，与必要权限提示区别",
    "target": "由本页基线确定的提前量和功能保持条件"
  }
}
```

`dataset`、`viewport`、`theme`、`role` 两边必须一致。记录字体加载稳定点与数据完成点；比较前关闭浏览器默认动画或等待动画稳定，避免异步字体造成假变化。`first_data_y` 相对视口顶部，以未滚动或明确复原的同一位置测量；前置区域高度应列明构成，不能直接拿顶部到数据的距离全部算多余。

可见性不能只看非零边界框：关闭的原生折叠子孙在部分浏览器仍可能返回几何值。先检查实际渲染/折叠状态，再检查视口、裁剪祖先和命中点遮挡；自动滚动能点击不代表控件原本没有被裁掉。

任务滚动量是实际完成路径累计滚动距离，含局部滚动；步骤记录点击/键盘动作并注明起止。可额外记录末条数据与表体底部距离、首屏操作遮挡、横向溢出和末项可达性。没有首条数据的空态应比较首个有效引导的位置；解释测量对象，不能填虚构数据。

## 执行检查

```bash
python3 scripts/check_ledger.py /path/to/ledger.json
python3 scripts/check_ledger.py /path/to/ledger.json --require-live --require-complete
```

退出 0 仅表示账本结构和所选门槛符合；退出 1 表示缺项或违规。校验器不会抓取 URL，不读取本机凭据，不判断 CSS，不把数字改善自动转为可用性通过。字段中的“通过”必须有实际证据支持。
