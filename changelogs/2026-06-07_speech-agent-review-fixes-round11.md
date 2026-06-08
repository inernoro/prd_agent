| fix | prd-api | 演讲 service 在 Ready 终态 UpdateOne MatchedCount==0 时（被新 run 抢占）改发 error 事件而非 done，前端不会误以为本次成功（Bugbot High "Done without Ready confirmation"） |
| fix | prd-api | 演讲 controller onModel 落库带 GenerationRunId 守卫，避免慢的旧 run 覆盖新 run 的 model/platform 元信息（Bugbot Medium "Model update ignores run guard"） |
