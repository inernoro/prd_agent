| fix | cds | 修复全局 Agent Key 作用域隔离两个提权漏洞（Codex P1/P2）：签发/吊销全局 Key 端点改为拒绝一切机器 Agent Key（含 create-only cdsg_），只允许人类 cookie 登录或 bootstrap 静态 key，杜绝 create-only key 给自己签全权 key / 吊销他人 key |
| fix | cds | 新增项目路由级作用域门卫：所有 /projects/:id/* 变更请求进 handler 前统一按项目 id 校验作用域，堵住 preview-mode/comment-template/files 等此前未显式校验的变更路由（create-only key 不再能改现有项目状态） |
