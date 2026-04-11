| fix | prd-api | PR Review V2：在 AppCallerRegistry 登记 pr-review.summary::chat 和 pr-review.alignment::chat。首次部署时 LLM Gateway 报 APP_CALLER_INVALID，因为新 AppCallerCode 没有写入代码侧注册表，管理端同步时检测不到 |
| fix | prd-api | PrSummaryService.ParseHeadline / PrAlignmentService.ParseAlignmentOutput 的正则 `[^\n#]+` 会在 LLM 输出中遇到 `#` 时截断（例如 "Fix #123"），改为 `[^\n]+` 抓整行并在业务层限长 |
| fix | prd-api | PrReviewController 档 1/3 的 StreamSummary / StreamAlignment 增加空输出防御：LLM 返回空内容时写入 Error 字段并推 error 事件，不再当成"成功但空白" |
| fix | prd-api | PrReviewController 补 using System.Text（首次部署时 StringBuilder 两处 CS0246 编译错误） |
