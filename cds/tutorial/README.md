# CDS 权威教程源文件

这里保存《CDS 权威教程》的书籍目录、专属章节、受控发布器和发布清单。知识库页面是发布结果，仓库文件是正文来源；两者通过 `publisher + sourceId + SHA256` 对齐。

本书不复制已经成熟的 CDS 指南。`manifest.json` 把 `doc/guide.cds.*.md`、生产发布规则和本目录的新章节编排成连续书籍；同一事实仍只有一个正文来源。

## 本地检查

```bash
python3 cds/tutorial/publisher.py check
python3 -m unittest cds/tutorial/test_publisher.py
```

检查会验证章节连续、源文件存在、正文达到最低深度、不含图片占位符、疑似明文密钥或 emoji，并输出总字符数与源码 SHA256。

## 生成发布计划

```bash
python3 cds/tutorial/publisher.py plan \
  --base-url https://map.ebcone.net \
  --store-id <CDS 权威教程知识库 ID>
```

优先使用 `MAP_DOC_STORE_KEY`。没有最小权限 Key 时，允许使用 `AI_ACCESS_KEY + MAP_AI_USER`，但发布器不会输出密钥。计划只读远端快照；发现人工修改、重复 `sourceId` 或受管节点漂移时拒绝覆盖。

## 发布

```bash
python3 cds/tutorial/publisher.py apply \
  --base-url https://map.ebcone.net \
  --store-id <CDS 权威教程知识库 ID>
```

第二次发布必须全部为 `noop`。中途失败只回滚本次新建且之后未被修改的节点，不删除人工内容、评论或其他发布器内容。
