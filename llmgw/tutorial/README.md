# 模型网关权威教程源文件

这里保存《模型网关权威教程》的可审计源文件。知识库页面是发布结果，仓库文件是正文来源；两者通过 `publisher + sourceId + SHA256` 对齐。

## 本地检查

```bash
python3 llmgw/tutorial/publisher.py check
python3 -m unittest llmgw/tutorial/test_publisher.py
```

检查会确认 0 至 32 章连续存在、每章具备完整操作与排错结构、下一章衔接正确，并拒绝图片占位符、疑似明文密钥和请求自报 `tenantId`。本轮视觉增密已经形成 104 张不同的圈选截图、212 个功能证据映射；修订后的 250 个编号步骤均在步骤下方直接跟图，共 284 次内联图片。全部截图逐张读回，不用“图片总数”代替功能覆盖。

## 生成发布计划

```bash
export MAP_DOC_STORE_KEY='<带 document-store:write scope 的临时 key>'
python3 llmgw/tutorial/publisher.py plan \
  --base-url https://map.ebcone.net \
  --store-id a406b53735494ac1bcf57c2de34b5b76
```

计划只读取快照，不写知识库。发布前必须确认没有人工漂移、重复 `sourceId`、缺失正文或不属于 manifest 的受管节点。

## 发布

```bash
python3 llmgw/tutorial/publisher.py apply \
  --base-url https://map.ebcone.net \
  --store-id a406b53735494ac1bcf57c2de34b5b76
```

发布器不会打印 key。中途失败时，只尝试逆序删除“本次运行新建且之后未被修改”的节点；既有章节、人工内容、评论和其他发布器内容都不会删除。相同版本第二次发布必须全部为 `noop`。
