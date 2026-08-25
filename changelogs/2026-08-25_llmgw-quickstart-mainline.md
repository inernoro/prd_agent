| feat | llmgw | Quickstart 改为左步骤右产物双栏单主线：一个主按钮签发，产物区从空态可见地长出来，结果块置顶 |
| feat | llmgw | 试跑失败按 error.code 归因成三环自检（密钥鉴权 / 团队与作用域 / 调用用途→模型池），给出一句归因与一个下一步 |
| feat | llmgw | 失败态主行动可直接给调用用途绑定默认模型池并重验；租户没有可用池时降级为去模型池创建 |
| refactor | llmgw | Quickstart 三处解释块合并为一处折叠「工作原理」；移除与首页重复的新人四步清单；页顶老手条与主卡地址改为分工不再重复 |
| test | llmgw | 新增 e2e/llmgw-quickstart-states.mjs：五状态、三环着色随错误码变化、结果块紧贴产物栏顶部、绑池主行动真的发 PUT |
