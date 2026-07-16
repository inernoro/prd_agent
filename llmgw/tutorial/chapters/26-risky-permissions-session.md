# 第 26 章 高风险权限和会话失效

## 你在做什么

这一章在隔离租户里检查三类高风险动作：Developer 的通配 key 请求被拒绝、已有 Developer 被停用或降权、一把独立限定 key 被撤销。本章不真正创建通配 key，也不操作唯一 Owner。

## 为什么要做

权限不是只在登录时检查一次。员工离组、账号停用或 key 撤销后，如果旧标签页和缓存令牌仍可用，就像收回门卡却没有锁门。高风险权限必须少给、可撤销、可审计，并及时让旧会话失效。

## 开始前检查

- 只在“教程咖啡店”操作[[第 5 章：创建团队和成员|第 5 章]]已创建的客服组 Developer，不停用、降权或修改唯一 Owner。
- 准备 Owner 和 Developer 两个独立浏览器会话；不需要额外创建备用 Owner 或 Admin。
- 记录客服组 Developer 当前角色与团队；不记录密码或 key 明文。
- Developer 只能创建明确限定 appCaller、协议和 scope 的团队密钥，不能创建通配 key。

## 跟我做

> 每做完一个编号步骤，就核对紧接在步骤下方的圈选图。同一步有两张图时，第一张确认入口或全貌，第二张确认字段或结果。

1. 以客服组 Developer 登录，进入“接入密钥”并点击“新建密钥”。名称填“教程通配拒绝”，Client code 填 `tutorial-risk-check`，环境选“测试”，AppCallerCodes 填 `*`，入口协议填 `openai-compatible`，Scopes 填 `invoke`，Team ID 留空。

**图 011 页面顶部明确当前租户由服务端会话确定**

![图 011 页面顶部明确当前租户由服务端会话确定](https://cds.miduo.org/api/reports/assets/7b897dbf41822f1f84a4ffbccaba538da6eb0439e369d83dd67062dda3400eda.png)

2. 页面应显示“Developer 不能创建通配密钥”，“创建密钥”不可提交。记录拒绝文案后点击“取消”；不勾选高风险确认，也不让 Owner 代为创建通配 key。

**图 016 五种角色用大白话说明最小权限**

![图 016 五种角色用大白话说明最小权限](https://cds.miduo.org/api/reports/assets/b3fc528c31beaf467b34bda7c6074a4714f638abe3ec59ffad805e8ef35d50f9.png)

3. 切回 Owner 会话，进入 `Quickstart`。选“文字对话”、“客服组”、“测试”，appCallerCode 填 `tutorial.gateway-book::chat`，Client code 填 `tutorial-revoke-check`，再点击“一键生成 appCaller 与 key”。这是一把独立限定 key，不是通配 key。

**本步位置复核：在同一圈选画面完成本步后再继续。**

![图 016 五种角色用大白话说明最小权限](https://cds.miduo.org/api/reports/assets/b3fc528c31beaf467b34bda7c6074a4714f638abe3ec59ffad805e8ef35d50f9.png)

4. 明文出现后，先在终端运行 `read -s REVOKE_KEY`，在无回显输入中粘贴并回车。key 只保存在当前终端内存；不粘贴到其他命令、文档或截图。

**图 055 test 与 production 使用不同 key，任一方可独立撤销**

![图 055 test 与 production 使用不同 key，任一方可独立撤销](https://cds.miduo.org/api/reports/assets/238d20abfe7ff8a19a887d906f8fc51a728dacadf19fab9f79799c271a1d0410.png)

5. 在 Developer 会话保留一个已打开页面，由 Owner 到“团队与成员”停用这名客服组 Developer。返回旧会话刷新并尝试访问原页，服务端应拒绝并要求重新登录。

**本步位置复核：在同一圈选画面完成本步后再继续。**

![图 055 test 与 production 使用不同 key，任一方可独立撤销](https://cds.miduo.org/api/reports/assets/238d20abfe7ff8a19a887d906f8fc51a728dacadf19fab9f79799c271a1d0410.png)

6. Owner 恢复该成员并保持客服组，让其重新登录；再把角色从 Developer 改为 Viewer。旧页的写操作必须被后端拒绝，刷新后导航按 Viewer 收敛。完成证据后把角色恢复为 Developer，所属团队仍只选“客服组”。

**图 056 列表只显示 key 前缀，不回显完整明文**

![图 056 列表只显示 key 前缀，不回显完整明文](https://cds.miduo.org/api/reports/assets/e88bbb93bc29143203df11d7983b5c4cbab76d8565bd9e549cf4aa0ca4b07ada.png)

7. 由 Owner 对这名测试成员执行“强制重新登录”，确认既有会话失效。本章不修改任何密码，不重置生产或他人账号。

**图 085 审计页按当前租户列出谁在什么时候改了什么**

![图 085 审计页按当前租户列出谁在什么时候改了什么](https://cds.miduo.org/api/reports/assets/7bf4e3d80e3ba99d57d77ed5f87ad70292d3e533beba21f903d0c7c51ce301b1.png)

8. 回“接入密钥”找到 Client code 为 `tutorial-revoke-check` 的密钥，点击“撤销”并确认。Quickstart 不能选择这把旧 key，所以不要在那里测试。在同一个终端复制下面命令，把第一行地址换成 Quickstart 显示的 Gateway 地址：

**本步位置复核：在同一圈选画面完成本步后再继续。**

![图 085 审计页按当前租户列出谁在什么时候改了什么](https://cds.miduo.org/api/reports/assets/7bf4e3d80e3ba99d57d77ed5f87ad70292d3e533beba21f903d0c7c51ce301b1.png)

```bash
export LLMGW_BASE_URL="https://map.ebcone.net"
curl -sS -o /tmp/llmgw-revoked-result.json -w '%{http_code}\n' \
  "$LLMGW_BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $REVOKE_KEY" \
  -H "X-Gateway-Source: external" \
  -H "X-Gateway-App-Caller: tutorial.gateway-book::chat" \
  -H "X-Gateway-Dry-Run: quickstart" \
  -H "Content-Type: application/json" \
  -d '{"model":"stub-chat","messages":[{"role":"user","content":"revoked-key-check"}]}'
unset REVOKE_KEY LLMGW_BASE_URL
```

9. 终端应只打印 `401`。这次请求在鉴权层结束，不调用上游；不要展示 `/tmp/llmgw-revoked-result.json` 中可能含有的内部错误细节。

**图 088 展开后只展示带 TenantId 的变更摘要和安全元数据**

![图 088 展开后只展示带 TenantId 的变更摘要和安全元数据](https://cds.miduo.org/api/reports/assets/eeb962e7ae42a3db155110a8779108786682bf5cf10d017021e4e2a8f7c95a7a.png)

10. 到“审计”核对真正到达服务端的限定 key 创建、成员停用与恢复、改角色、强制退出和撤销记录。第 2 步只由页面在提交前拦截，没有 API 请求，因此不会产生“通配拒绝”审计；它的证据是禁用按钮和拒绝文案，不能在审计中伪造一条记录。顶部当前租户和目标对象必须都属于“教程咖啡店”。

**本步位置复核：在同一圈选画面完成本步后再继续。**

![图 088 展开后只展示带 TenantId 的变更摘要和安全元数据](https://cds.miduo.org/api/reports/assets/eeb962e7ae42a3db155110a8779108786682bf5cf10d017021e4e2a8f7c95a7a.png)

## 看到什么算成功

Developer 在明确字段填入 `*` 后仍无法提交，而不是先创建再补救。客服组 Developer 停用、降为 Viewer 和强制退出后，旧会话立即失去对应能力；恢复后角色与团队回到原状。独立限定 key 撤销后返回 401。

## 失败怎么办

- 停用后旧会话还能写入：立即停止该账号使用，检查服务端每次请求的成员状态验证，不能只清浏览器菜单。
- Developer 能创建通配 key：撤销该 key，按权限升级问题处理。
- 唯一 Owner 误被操作：立即停止本章，不通过直接改库绕开正常授权流程；本章只允许操作客服组 Developer。
- 撤销 key 仍返回成功：先确认终端变量确实保存的是 `tutorial-revoke-check` 明文，并按 ServiceKeyId 对照日志；若确认复现，停止外部接入。
- 页面要求先改密码才能继续：停止本章并请管理员核对账号策略；教程不通过重置密码来完成权限验收。

## 本章小结

你验证了高风险权限的最小授予与及时收回。真正安全的系统既要隐藏不该点的入口，也要让服务端在旧会话、旧链接和旧 key 上再次拒绝。

## 下一章

点击 [[第 27 章：四协议保真验收]]，检查同一业务意图在四种协议下是否保持一致。
