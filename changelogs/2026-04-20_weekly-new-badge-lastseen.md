| fix | prd-admin | 周报 NEW 徽章逻辑改为「以上次打开更新中心那一天的 23:59:59 为 cutoff」：条目更新时间严格晚于 cutoff 才标 NEW；首次进入（lastSeenAt 为 null）一律不标。mount 时冻结 cutoff，不受当次 markAsSeen 影响 |
