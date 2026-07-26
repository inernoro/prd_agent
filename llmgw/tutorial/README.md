# 模型网关权威教程源文件

这里保存《模型网关权威教程》的可审计源文件。知识库页面是发布结果，仓库文件是正文来源；两者通过 `publisher + sourceId + SHA256` 对齐。

## 本地检查

```bash
python3 llmgw/tutorial/publisher.py check
python3 -m unittest llmgw/tutorial/test_publisher.py llmgw/tutorial/test_maintenance.py
```

检查会确认 0 至 32 章连续存在、每章具备完整操作与排错结构、下一章衔接正确，并拒绝图片占位符、疑似明文密钥和请求自报 `tenantId`。主线之外的“实战教程”目录按真实问题组织，当前覆盖逻辑模型目录、多上游 Offering、异构协议故障切换、限流、日志验证和三分钟 Quickstart。模型池只作为未显式选择时的默认与兼容路径。图片数量只作为容量统计，页面、教程步骤和截图是否真正对应由下面的双链巡检单独验证。

跨章节引用必须写成 `[[完整章节标题|第 N 章]]`。公开分享页会把它解析成库内跳转并同步 `?entry=` 深链，读者点击后直接进入目标章节。发布器校验会拒绝遗留的纯文字跨章节引用；代码块、行内代码、图片和已有链接不参与转换。

## 每日漂移巡检

`maintenance-map.json` 维护页面、路由、共享组件、接口到教程步骤的正向关系，扫描器结合 `manifest.json` 和 `evidence-map.json` 自动生成反向表。核心页面已经链接到稳定 `stepId` 与 `evidenceId`；其余章节级关系明确标成粗粒度待迁移，不能冒充已经同步。

每日 Codex“教程双链”任务调用 `tutorial-daily-maintain` 技能。没有命中 LLMGW 页面、共享组件、接口、教程或证据变化时返回 `skipped`，不生成报告和更新草稿；有变化时按目标提交生成固定随机种子，抽查至少 5 个页面并记录每个断言。GitHub workflow 只承担 PR 与手动静态门禁，避免重复产生第二份每日报告。巡检始终是报告模式，不自动修改正文、截图、DailyTips seed 或远端知识库。

本地可按时间窗口或基准提交执行：

```bash
python3 llmgw/tutorial/maintenance.py --since "1 day ago" --fail-on-drift
python3 llmgw/tutorial/maintenance.py --base-ref origin/main --fail-on-drift
python3 llmgw/tutorial/maintenance.py --since "0 seconds ago" --force-audit --seed "$(git rev-parse HEAD)" --sample-size 5 --fail-on-drift
```

目录顺序以 `manifest.json` 的 `sortOrder` 为作者定义的书籍顺序。基础篇、中级篇、高级篇、实战教程及各自内容使用递增值，分享页选择“书籍顺序”后按该值展示；缺少 `sortOrder` 时按自然数字标题兜底。

## 生成发布计划

```bash
export MAP_DOC_STORE_KEY='<带 document-store:write scope 的临时 key>'
python3 llmgw/tutorial/publisher.py plan \
  --base-url https://map.ebcone.net \
  --store-id a406b53735494ac1bcf57c2de34b5b76
```

计划只读取快照，不写知识库。发布前必须确认没有人工漂移、重复 `sourceId`、缺失正文或不属于 manifest 的受管节点。

发布计划是条目级增量计划：只有正文、标题、父目录、标签或 `sortOrder` 发生变化的 `sourceId` 才会更新，未变化章节保持 `noop`。接口每次提交该条目的完整正文和 SHA256，不是字符区间 Patch，因此既能增量发布，又能在人工改过远端正文时停止覆盖。

## 发布

```bash
python3 llmgw/tutorial/publisher.py apply \
  --base-url https://map.ebcone.net \
  --store-id a406b53735494ac1bcf57c2de34b5b76
```

发布器不会打印 key。中途失败时，只尝试逆序删除“本次运行新建且之后未被修改”的节点；既有章节、人工内容、评论和其他发布器内容都不会删除。相同版本第二次发布必须全部为 `noop`。
