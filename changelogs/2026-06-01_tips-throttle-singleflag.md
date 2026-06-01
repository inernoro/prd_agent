| fix | prd-admin | 教程小书首访兜底删除冗余 FIRST_VISIT_SHOWN_KEY，避免与日级节流双 flag 不一致（bugbot ref1：旧 flag 在 targeted-tip 路径先触发时永不写入，跨日 remount 会让新用户路径误触发） |
