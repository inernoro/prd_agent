| fix | cds | 调度器永不降温主干分支：SchedulerService.isPinned 新增按 git 分支名判定主干（项目 gitDefaultBranch，兜底 main/master），与 Project.defaultBranch（CDS 分支 id，可能未配置/不符）解耦，根治「主分支空闲超阈值被自动降温」。空闲降温与容量驱逐两条路径均跳过主干 |
