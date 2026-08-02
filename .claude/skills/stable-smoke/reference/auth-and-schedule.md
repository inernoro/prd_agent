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

## 账号与密钥持久化

账号本体保存在测试环境和正式环境各自的用户数据库，固定使用不同的专用用户名。仓库的 `.env.template` 只登记变量名；开发者本机可把真实值放入被 git 忽略的 `.env`；48 小时任务使用 GitHub Secrets；CDS 和正式发布使用各自的部署密钥。禁止把真实密码、AI 密钥、一次性票据或 token 提交到仓库。

每轮前置检查必须验证账号存在、未禁用、在合成登录白名单、权限符合矩阵。检查失败归类为 environment 并通知，不能把它解释成产品通过。

## CI 所需密钥

| 环境 | 地址 | AI 密钥 | 专用账号 |
|---|---|---|---|
| 测试 | Actions variable `STABLE_SMOKE_TEST_BASE_URL` | Actions secret `STABLE_SMOKE_TEST_AI_ACCESS_KEY` | Actions secret `STABLE_SMOKE_TEST_USER` |
| 正式 | Actions variable `STABLE_SMOKE_PROD_BASE_URL` | Actions secret `STABLE_SMOKE_PROD_AI_ACCESS_KEY` | Actions secret `STABLE_SMOKE_PROD_USER` |
| MAP 通知 | Actions variables `STABLE_SMOKE_NOTIFY_BASE_URL`、`STABLE_SMOKE_NOTIFY_SOURCE` | Actions secret `STABLE_SMOKE_NOTIFY_AI_ACCESS_KEY` | Actions variables `STABLE_SMOKE_NOTIFY_USER` + `STABLE_SMOKE_NOTIFY_TARGET_USER_ID` |

地址、用户名和目标用户 ID 使用 Actions variables；密码、AI 密钥和 token 只存 Actions secrets 或等价密钥系统，不提交到仓库。工作流在迁移期兼容共用的 `AI_ACCESS_KEY` 与 `E2E_USER`，但目标状态是正式和测试环境使用不同 AI 密钥与不同账号。目标用户 ID 必须配置，脚本拒绝降级成全局通知。生产 API 尚未发布 `stable-smoke` 来源前，`STABLE_SMOKE_NOTIFY_SOURCE` 使用 `system-alert`；发布后切为 `stable-smoke`。

## 48 小时调度

工作流文件为 `.github/workflows/stable-smoke-48h.yml`：

- GitHub 调度器每天在北京时间 02:17 唤醒。
- 任务按 Unix 日编号奇偶门控，只在固定一半日期执行，因此跨月仍保持 48 小时间隔。
- `workflow_dispatch` 用于首次运行、缺陷复测和紧急人工触发，不受日期门控。
- `concurrency` 禁止同一时刻出现两轮稳定冒烟。
- 测试环境和正式环境独立出结果，不允许一边失败导致另一边证据丢失。
- PR 只运行业务功能目录和变更映射门禁；合并到默认分支后，定时任务才会注册并按 48 小时执行。

## 每轮报告

CI 必须上传 Playwright HTML、JSON、截图、trace 和视频。知识库报告按稳定冒烟九段式归档，至少包含：目标、范围、环境、身份方式、模块结果、失败证据、双环境差异、清理结果、下一步动作。

若密钥缺失、开关未开或账号不在白名单，结果是 `conditional` 或 `fail`，不得用跳过伪装成通过。
