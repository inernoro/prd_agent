| refactor | llmgw | 控制台字体收敛为七档阶梯（以「请求记录」页为基准），theme.css 新增 --fs-*/--fw-*/--lh-* token，删除 9~24px 一次性字号 |
| fix | llmgw | 页头 SSOT 统一：全部 17 个控制台页面的 h1 都是 20px，Provider/模型/审计/影子对比/系统运维补上缺失的页面标题 |
| fix | llmgw | 修复会话过期后卡在「登录已失效，请重新登录」不跳转：api 层广播失效事件、AuthProvider 翻转登录态、路由守卫送回登录页并保留原页面地址 |
| feat | llmgw | 会话到点主动登出（不必等下一次点击撞 401），跨标签页同步下线，登录页说明失效原因（过期 / 成员关系被作废） |
| chore | llmgw | 新增字体阶梯守卫 pnpm check:typography，阻止再写阶梯外的硬编码字号 |
