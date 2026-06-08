| fix | prd-admin | 演讲编辑器错误 banner 覆盖非终态错误：只要 errorMessage 存在就展示（并发拒绝/SSE 网络错原本静默）（Bugbot Medium "SSE errors hidden from users"） |
| fix | prd-api | 演讲 SourceText 落库前截断到 16K（与 LLM 实际使用一致）：避免 DB 存 1MB 但模型只看 16K 的认知错位，也防止 MongoDB 16MB doc limit 撞库（Bugbot Medium + Codex P2 "Source text not truncated" / "Bound persisted source text size"） |
| fix | prd-api | 演讲发布 HTML 播放器无根节点兜底：root 缺失时不再 throw 整屏白屏，挂错误提示并跳过 build（Bugbot Low "Published player crashes without root"） |
