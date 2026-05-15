| feat | prd-admin | CDS Agent 页新增简洁/专业双模式切换，简洁模式三栏（任务列表/对话/产物），工具调用渲染为中文动作，默认简洁、sessionStorage 记忆，专业模式 JSX 零改动 |
| feat | prd-admin | CDS Agent 简洁模式对话改为消息+事件按时间合并的单一时间线（旧上新下、自动滚底），连续过程事件折叠进「执行过程」块（步数+用时，默认收起，含待审批时强制展开） |
| fix | prd-admin | CDS Agent 发送后清空输入框（修复文本残留），运行中每 3s 自动轮询刷新（消除空白等待），底部显示「Agent 正在执行…已等待 Xs」 |
| feat | prd-admin | CDS Agent 简洁模式右栏新增 Git/PR 上下文卡片（分支/提交/PR 链接）+ 一键生成产物；左侧任务按运行中/已完成分组并加活动指示点；最新 Agent 回复用 StreamingText 流式打字 |
