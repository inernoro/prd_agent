| fix | prd-api | 演讲智能体 SSE 写入：ConnectionResetException 继承自 IOException，只 catch 父类即可（修 CS0160 编译错误，导致 CDS 部署失败） |
| fix | prd-api | 演讲智能体知识库建演讲：支持用户自填标题（空时回落 entry.Title），走 IDocumentService.GetByIdAsync 保持缓存一致，思维导图 JSON 解析兼容 root.children 嵌套（Bugbot Medium 三项） |
| fix | prd-api | 演讲智能体 model SSE 事件：onModel 改为 awaitable Func，落库与 SSE 写入串行化，避免与紧随的 thinking/text 帧交错（Codex P2） |
| fix | prd-admin | 演讲创建页知识库通道：将用户自填标题透传到 createFromDocument |
