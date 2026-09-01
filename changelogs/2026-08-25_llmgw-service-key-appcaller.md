| feat | llmgw | 接入密钥新建表单改为「填用途 + 选调用类型」自动生成 appCallerCode，生成值当场可见，签发前顺带登记调用用途 |
| fix | llmgw | 接入密钥高级设置的「Team ID」手抄输入框改成真实团队下拉，空值仍表示租户级密钥 |
| test | llmgw | 新增 e2e/llmgw-service-key-appcaller.mjs：断言界面显示的 code 与两个写请求体一致、生成值过 console-api 自助登记判据 |
