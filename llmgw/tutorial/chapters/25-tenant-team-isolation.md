# 第 25 章 多租户和团队隔离自检

## 你在做什么

这一章分成两层：普通管理员只在页面检查自己有权切换的测试租户；项目验收人员再在隔离测试数据库运行仓库已有的对抗矩阵。普通用户不手工伪造 tenantId，也不猜 id 发删除请求。

## 为什么要做

只测试“正常能打开”远远不够。真实风险常藏在猜 id、旧标签页、并发切租户、同名对象和缓存里。最重要的原则是：TenantId 只能由服务端登录会话或当前 key 解析，任何请求自报 tenantId 都不可信。

## 开始前检查

- 使用专门的隔离测试账号和公开教程桩，不接触生产租户、生产 key 或共享池。
- 只有账号本来就同时属于租户 A“教程咖啡店”和租户 B“教程面包店”时，才做页面切换；没有第二租户就跳过页面对比，不自行创建攻击账号。
- 为客服组和内容组分别准备最小权限成员及 scoped key。
- 所有测试只保留遮盖后的身份和 requestId，不记录 key 明文。
- 对抗矩阵仅由能进入仓库、具备 .NET SDK 和隔离 MongoDB 的验收人员执行；这不是普通租户操作。

## 跟我做

> 每做完一个编号步骤，就核对紧接在步骤下方的圈选图。同一步有两张图时，第一张确认入口或全貌，第二张确认字段或结果。

1. 在租户 A 查看模型池、Exchange、接入密钥、请求记录、预算与用量、审计的可见数量，只记数量和遮盖后的对象名称。

**图 010 从左侧导航点击“团队与成员”，不用猜页面地址**

![图 010 从左侧导航点击“团队与成员”，不用猜页面地址](https://cds.miduo.org/api/reports/assets/7d10c3faa03b6daaf25feb2fa662a0c61f4cdb3d607bca3ff3743a4e71a03e1e.png)

**图 011 页面顶部明确当前租户由服务端会话确定**

![图 011 页面顶部明确当前租户由服务端会话确定](https://cds.miduo.org/api/reports/assets/7b897dbf41822f1f84a4ffbccaba538da6eb0439e369d83dd67062dda3400eda.png)

2. 用顶部租户切换进入租户 B，再查看相同页面。页面只应出现租户 B 自己的数据；不要在地址栏添加 tenantId，也不要粘贴租户 A 的对象 id。

**图 012 租户行为与额度管理地图给出 appCaller、key 和用量三处入口**

![图 012 租户行为与额度管理地图给出 appCaller、key 和用量三处入口](https://cds.miduo.org/api/reports/assets/61e7dd789a2e2dd44cbffd76c768b4a1828bcde5992cae9787fdbd524f9b24de.png)

**图 013 业务预算和业务速率在 appCaller 管理**

![图 013 业务预算和业务速率在 appCaller 管理](https://cds.miduo.org/api/reports/assets/e376a42cfffd63bc374a801573d108cee7e968e2dad7c0f15d01e1cde9555d66.png)

3. 切回租户 A，使用客服组成员查看请求记录，再用内容组成员查看。各自只看到被分配团队范围；Owner 可以看本租户两组，但不能看到租户 B。

**图 014 单个接入方的速率与撤销在接入密钥管理**

![图 014 单个接入方的速率与撤销在接入密钥管理](https://cds.miduo.org/api/reports/assets/394491eb2ee240f07aa006741c2591f53961609b4b90b8ec23bd69eff8e7f7eb.png)

**图 015 租户汇总和费用可信度从预算与用量进入**

![图 015 租户汇总和费用可信度从预算与用量进入](https://cds.miduo.org/api/reports/assets/36c0dcde6c50d293c4e77bb1ac253fcabfa061512a81d8e01852b855262cb684.png)

4. 普通管理员到这里结束。下面是验收人员步骤：在仓库根目录连接专用测试 MongoDB，确认连接不是生产库，然后执行现有测试：

**图 016 五种角色用大白话说明最小权限**

![图 016 五种角色用大白话说明最小权限](https://cds.miduo.org/api/reports/assets/b3fc528c31beaf467b34bda7c6074a4714f638abe3ec59ffad805e8ef35d50f9.png)

**图 017 Owner 在同一页填写名称与短标识后创建并切换租户**

![图 017 Owner 在同一页填写名称与短标识后创建并切换租户](https://cds.miduo.org/api/reports/assets/b869ff90924791edc19bd08ded9c4d92bd8a92d6cbe9dac56541815e134f390f.png)

```bash
dotnet test prd-api/PrdAgent.sln --no-restore \
  --filter "FullyQualifiedName~GatewayConsoleTenantAccessTests"
```

5. 该套件会在随机命名的临时数据库创建两租户、两团队、两用户和每团队两把 key，自动验证列表、详情、禁止写入和会话失效，结束后删除临时数据库。它不会读取教程 key，也不要求人工猜 id。

**图 018 团队把成员、appCaller 和密钥收进同一工作范围**

![图 018 团队把成员、appCaller 和密钥收进同一工作范围](https://cds.miduo.org/api/reports/assets/7b3b663ad647d7eb317bd3aebb0682585fdd834bf9ebca169866bf6a7ab245f9.png)

**图 019 添加成员时需要账号、初始密码、角色和团队范围**

![图 019 添加成员时需要账号、初始密码、角色和团队范围](https://cds.miduo.org/api/reports/assets/4e96e4a9afebc80e887c056a83adb3373dc7176749e4366376d357c309325624.png)

6. 再执行静态数据域守卫，确认服务端查询仍包含租户边界：

**图 020 成员列表支持角色、状态、团队和会话失效管理**

![图 020 成员列表支持角色、状态、团队和会话失效管理](https://cds.miduo.org/api/reports/assets/dbe54e448e83433a7c0ada151fb23bb1db96f48a99f976baa0aceabd26536f1c.png)

**图 085 审计页按当前租户列出谁在什么时候改了什么**

![图 085 审计页按当前租户列出谁在什么时候改了什么](https://cds.miduo.org/api/reports/assets/7bf4e3d80e3ba99d57d77ed5f87ad70292d3e533beba21f903d0c7c51ce301b1.png)

```bash
dotnet test prd-api/PrdAgent.sln --no-restore \
  --filter "FullyQualifiedName~GatewayDataDomainGuardTests"
```

7. 保存测试总数和通过结果，不保存 MongoDB 连接串。任何一项失败都不能宣称租户隔离验收完成。

**图 088 展开后只展示带 TenantId 的变更摘要和安全元数据**

![图 088 展开后只展示带 TenantId 的变更摘要和安全元数据](https://cds.miduo.org/api/reports/assets/eeb962e7ae42a3db155110a8779108786682bf5cf10d017021e4e2a8f7c95a7a.png)

### 再检查一个常被忽略的边界：限制是否串租户

在租户 A 把教程 appCaller 的月预算和速率设为一个容易识别的测试值，再切到租户 B 查看同名 appCaller。租户 B 不能继承、覆盖或读到租户 A 的值。接入密钥也一样：同样的显示名称不代表同一把 key，撤销租户 A 的 key 不能让租户 B 的 key 失效。

本项只使用隔离测试数据，不需要真的消耗预算。页面读回和服务端测试能证明配置带 TenantId；不要为了“看到超限”而调用付费模型。

## 看图核对

切换租户前后，先看红框中的服务端边界说明；页面不能提供通过自报 tenantId 改变范围的入口。

![红框说明租户范围只能由服务端会话确定](https://md-private-1251304948.cos.ap-guangzhou.myqcloud.com/data/cds/img/czjcj3a46fwh73qd65mew6apcm.png)

未知角色出现时，页面必须停在红框提示并要求重新登录或联系 Owner，不能继续加载业务接口。

![红框提示未知租户角色被默认拒绝](https://md-private-1251304948.cos.ap-guangzhou.myqcloud.com/data/cds/img/j6eidk3kkblwmkohmkcit7ndae.png)

## 看到什么算成功

页面切换只展示当前会话租户和团队范围；隔离数据库中的 `GatewayConsoleTenantAccessTests` 与 `GatewayDataDomainGuardTests` 全部通过，自动证明跨租户详情不可读取、跨边界写入会被拒绝、同名对象按租户隔离、失效会话不能继续操作。

## 失败怎么办

- 租户 B 能看到租户 A 名称或 id：立即停止测试，保留最小响应证据，按最高安全级别处理。
- 跨租户同名被错误判重：检查唯一索引和查询是否漏了 TenantId，不要靠改名称绕过。
- 页面切换后仍显示上一租户数据：先停止操作并刷新；若仍存在，按隔离问题处理，不能只改前端缓存。
- 测试要求生产 MongoDB 连接：立即停止。该命令只能连接专用测试库，不能为了通过验收扩大范围。
- 团队拒绝返回了目标详情：即使写入失败也存在信息泄露，应改成不暴露对象存在性的结果。
- 租户 A 的预算或速率出现在租户 B：按跨租户数据泄漏处理。不要先在页面上删掉它，因为删除可能继续扩大影响；先保留对象 id、当前租户和时间证据。

## 本章小结

租户隔离不是靠用户手工攻击生产接口证明的。普通管理员检查可见范围，验收人员用隔离数据库的既有对抗矩阵验证详情、写入、会话和索引边界。

## 下一章

点击 [[第 26 章：高风险权限和会话失效]]，验证通配 key、停用成员和强制退出。
