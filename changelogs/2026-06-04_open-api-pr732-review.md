| fix | prd-api | 开放接口流式 chat 在错误/异常/无 Done chunk 退出时补发 `data: [DONE]` 终止符，兼容 OpenAI SDK 收尾 |
| fix | prd-api | 开放接口每日请求配额改用 INCR-then-check + 超额回滚，消除"读-判-写"竞态 |
| fix | prd-admin | 开放接口本页教程步骤补 tab-gated 锚点回落，默认 tab 非开放接口时不卡步 |
| fix | prd-api | 开放接口准入把每日请求配额校验移到速率窗口前，日配额拒绝不再白白占用分钟桶槽位，速率拒绝回滚日配额占用 |
| fix | prd-api | 开放接口输入字符上限纳入多模态 image_url（base64 数据 URI），大图不再绕过 MaxInputChars 直打上游 |
