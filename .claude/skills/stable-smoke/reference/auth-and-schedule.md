# 合成登录与定时执行

## 目标

在密码登录关闭、真人 SSO 需要扫码的环境中，让自动化测试使用独立账号进入系统，同时保证该能力不能演变成通用登录后门。

## 安全边界

1. 每个环境必须显式设置 `SYNTHETIC_LOGIN_ENABLED=true`，默认关闭。
2. `SYNTHETIC_LOGIN_ALLOWED_USERS` 只列稳定冒烟专用账号，禁止加入日常真人管理员账号。
3. 签发接口仅接受 `X-AI-Access-Key` 认证，并以 `X-AI-Impersonate` 指定的已存在账号为准。
4. 一次性票据有效期 1-5 分钟，默认 3 分钟；服务端只保存哈希，消费后立即失效。
5. 登录会话最长 30 分钟，不签发 refresh token，不能滑动续期。
6. 返回地址只接受 `/` 开头的站内路径，拒绝绝对地址、协议相对地址和反斜杠路径。
7. 服务端审计只记录 ticketId、账号、失效时间、requestId，不记录票据、密钥和访问令牌。
8. 发生异常时先关闭 `SYNTHETIC_LOGIN_ENABLED`，再轮换 `AI_ACCESS_KEY`，最后审计票据签发记录。

## 超级指令

生成 3 分钟入口并打开目标页面：

```bash
AI_ACCESS_KEY='<从安全变量注入>' \
scripts/stable-smoke-login.sh \
  --base '<环境权威地址>' \
  --user '<合成测试专用账号>' \
  --return-url '/visual-agent' \
  --minutes 3 \
  --open
```

命令只应在受控终端使用。不要把输出的登录地址粘贴到工单、报告或聊天记录；它虽然短时失效，仍属于临时凭据。

## CI 所需密钥

| 环境 | 地址 | AI 密钥 | 专用账号 |
|---|---|---|---|
| 测试 | Actions variable `STABLE_SMOKE_TEST_BASE_URL` | Actions secret `AI_ACCESS_KEY` | Actions secret `E2E_USER` |
| 正式 | Actions variable `PRD_AGENT_PROD_BASE` | Actions secret `AI_ACCESS_KEY` | Actions secret `E2E_USER` |

地址使用 Actions variables，账号和密钥只存 Actions secrets 或等价密钥系统，不提交到仓库。现有工作流兼容共用的 `AI_ACCESS_KEY` 与 `E2E_USER`；完成密钥拆分后应升级为正式和测试环境分别使用不同的 AI 密钥与不同账号。

## 48 小时调度

工作流文件为 `.github/workflows/stable-smoke-48h.yml`：

- GitHub 调度器每天在北京时间 02:17 唤醒。
- 任务按 Unix 日编号奇偶门控，只在固定一半日期执行，因此跨月仍保持 48 小时间隔。
- `workflow_dispatch` 用于首次运行、缺陷复测和紧急人工触发，不受日期门控。
- `concurrency` 禁止同一时刻出现两轮稳定冒烟。
- 测试环境和正式环境独立出结果，不允许一边失败导致另一边证据丢失。

## 每轮报告

CI 必须上传 Playwright HTML、JSON、截图、trace 和视频。知识库报告按稳定冒烟九段式归档，至少包含：目标、范围、环境、身份方式、模块结果、失败证据、双环境差异、清理结果、下一步动作。

若密钥缺失、开关未开或账号不在白名单，结果是 `conditional` 或 `fail`，不得用跳过伪装成通过。
