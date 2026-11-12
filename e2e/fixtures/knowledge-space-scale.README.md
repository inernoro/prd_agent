# 知识库规模隔离验证

只面向本地专用容器，固定数据库 `kb_scale_isolated`。不要把脚本指向既有数据库或生产服务。

准备 .NET 8、Docker、pnpm 依赖与 Playwright Chromium。单独创建测试容器：

```bash
mkdir -p work/evidence
docker run -d --name kb-scale-mongo --ulimit nofile=16384:16384 -p 127.0.0.1:27017:27017 mongo:8.0
docker run -d --name kb-scale-redis -p 127.0.0.1:6379:6379 redis:7-alpine
ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS=http://0.0.0.0:5001 MongoDB__DatabaseName=kb_scale_isolated MAP_INITIAL_ADMIN_USERNAME=scale_admin MAP_INITIAL_ADMIN_PASSWORD=ScaleIsolated2026pass Redis__ConnectionString=localhost:6379 dotnet run --no-launch-profile --project prd-api/src/PrdAgent.Api
```

以上口令仅用于新建的本地夹具账号，禁止用于真实部署。API 完成初始化后，在另一个终端执行：

```bash
docker exec -i kb-scale-mongo mongosh --quiet < e2e/fixtures/knowledge-space-scale.seed.js
pnpm --dir prd-admin build
pnpm --dir prd-admin exec vite preview --host 127.0.0.1 --port 8010 --strictPort
```

再从仓库根目录运行：

```bash
SCALE_API_URL=http://localhost:5001 node e2e/knowledge-space-scale-api.mjs
SCALE_BASE_URL=http://localhost:8010 SCALE_ROUNDS=3 node e2e/knowledge-space-scale-benchmark.mjs optimized
SCALE_BASE_URL=http://localhost:8010 node e2e/knowledge-space-scale-ui.mjs
```

可用 `SCALE_CHROME_PATH` 指定已经安装的 Chromium。脚本以正常登录、导航、展开、输入和点击取得证据，不注入登录状态。性能脚本每档搜索前把奇数条目的旧短索引设为空，模拟历史缺索引空间；旧版本会在搜索时回填，新版本直接只读查询完整正文。首次索引路径与后续索引齐备路径应分别解释。

每个空间恰有 200、1000、5000 篇正文文档，另有 4 个目录节点（合计 204、1004、5004 条记录）（一个是历史订阅目录）、一个缺失父节点条目。文件正文超过 2000 字符，末尾带唯一检索词，创建时间全部相同以覆盖排序边界。环和自引用在前端单元测试中验证。

API 脚本检查全量去重、标题和正文搜索全覆盖、附件尾部、正则字面量、私有库隔离、公开只读、团队权限撤销和分页期间插入/删除。仅修改并恢复自己的夹具记录。浏览器脚本输出各档耗时、实际请求清单、截图和 Playwright trace 到 `work/`。分享 trace 前必须移除认证头与会话数据。

全量后端测试应使用另一套 MongoDB 和 Redis（尤其 Redis 队列隔离测试固定要求 `127.0.0.1:16388`），不要与性能测试并行。测试集合多时 MongoDB 需要足够的文件句柄上限。最终报告须注明浏览器、构建版本、数据库版本、测量次数、缓存和网络条件；本地证据不能替代真实分支预览验收。

测试结束后可删除本次专用容器与其测试卷；无需执行任何既有数据迁移。

本轮本地诊断记录见 [summary.json](knowledge-space-scale-results/summary.json)，其中区分本地通过与真实 CDS 验收受阻；原始三轮记录、完整请求清单、12 格遍历、截图和脱敏轨迹均在同目录。此记录不是已部署版本的正式验收报告。

分享其他 trace 前，可执行 `python3 e2e/knowledge-space-scale-sanitize.py 输入.zip 输出.zip` 清除认证头和会话数据。
