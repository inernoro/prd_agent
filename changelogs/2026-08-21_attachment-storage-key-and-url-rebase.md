| feat | prd-api | 保存资产时回填对象 key（`StoredAsset.Key`），所有建附件的地方存进 `Attachment.StorageKey`，附件地址不再只有绝对 URL 这一份来源 |
| feat | prd-api | 跨实例同步在落库前把附件地址改写成本站地址（`DataSyncAssetUrls`，key 优先、存量按内容寻址形状从 URL 反推） |
| feat | prd-api | Run 进度新增「地址已改写 / 认不出」两个计数，同步接口与 SSE 一起送出 |
| feat | prd-admin | 同步结果页新增「附件地址」卡片：说清改写了几条、还有几条没救，并明说这次只搬记录没搬文件 |
| test | prd-api | 补 DS1 的判据单测与三条接线守卫（改写必须排在落库之前、存储必须回填 key、建附件必须存 key），四条都做过红绿闭环 |
| docs | prd-api | debt.platform.cross-instance-data-sync.md 的 DS1 拆成「地址」与「字节」两半，前者标已修、后者保持 open 并写明未验证 |
