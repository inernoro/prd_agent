# 模型网关权威教程源文件

这里保存《模型网关权威教程》的可审计源文件。知识库页面是发布结果，仓库文件是正文来源；两者通过 `publisher + sourceId + SHA256` 对齐。

## 本地检查

```bash
python3 llmgw/tutorial/publisher.py check
python3 -m unittest llmgw/tutorial/test_publisher.py
```

检查会确认 0 至 32 章连续存在、每章具备完整操作与排错结构、下一章衔接正确，并拒绝图片占位符、疑似明文密钥和请求自报 `tenantId`。本轮视觉增密已经形成 136 个不同图片地址、222 个功能证据映射；修订后的 255 个编号步骤均在步骤下方直接跟图，共 294 次内联图片。全部截图逐张读回，不用“图片总数”代替功能覆盖。

跨章节引用必须写成 `[[完整章节标题|第 N 章]]`。公开分享页会把它解析成库内跳转并同步 `?entry=` 深链，读者点击后直接进入目标章节。发布器校验会拒绝遗留的纯文字跨章节引用；代码块、行内代码、图片和已有链接不参与转换。

目录顺序以 `manifest.json` 的 `sortOrder` 为作者定义的书籍顺序。基础篇、中级篇、高级篇及各自章节使用递增值，分享页选择“书籍顺序”后按该值展示；缺少 `sortOrder` 时按自然数字标题兜底。

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
