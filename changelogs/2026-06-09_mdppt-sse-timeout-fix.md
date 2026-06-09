| fix | prd-api | MdToPpt MAP路径：超时从180s提升至600s，OperationCanceledException改为发error事件而非静默吞掉，添加SSE keepalive防代理断连 |
| fix | prd-admin | mdToPptService：stream意外关闭未收到done/error时调用onError解除前端"生成中"卡死 |
