| fix | prd-api | 修复 Model Lab 批量测试全部无输出问题：WriteWithLockAsync 改用 CancellationToken.None 防止 HttpContext.RequestAborted 级联取消，LLM 调用同步修正 (#602) |
