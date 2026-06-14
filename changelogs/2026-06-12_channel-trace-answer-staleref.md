| fix | prd-admin | 商品溯源智能体-问题排查：修复 AI 回答流式输出几行后塌缩成空框（onDone/onError 的 setMessages 惰性 updater 读到被同步清空的 streamRef，落库空内容；改为先取局部常量再提交） |
