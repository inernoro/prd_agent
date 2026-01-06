# 资源管理重构指南

## ✅ 已完成所有改动

### 后端 API
- ✅ `DesktopAsset` 表（key + skin + url）
- ✅ 上传接口自动添加扩展名
- ✅ `GET /api/v1/admin/assets/desktop/matrix` 返回资源矩阵（带回退逻辑）
- ✅ Branding 接口返回完整 URL

### Desktop 前端
- ✅ 使用 `branding.loginIconUrl` 和 `branding.loginBackgroundUrl`
- ✅ 支持 MP4 视频背景
- ✅ 移除本地 URL 拼接逻辑

### Admin 前端
- ✅ 显示 key 而非文件路径（如 `bg` + `dark` 标签）
- ✅ 所有输入自动移除扩展名
- ✅ 默认资源 key 更新（`start_load`、`load`、`bg`）
- ✅ 品牌配置 key 默认值更新

## Admin 前端核心改动（仅供参考）

### 文件：`prd-admin/src/pages/AssetsManagePage.tsx`

#### 1. 调用新接口
```tsx
import { getDesktopAssetsMatrix } from '@/services';
import type { AdminDesktopAssetMatrixRow } from '@/services/contracts/desktopAssets';

// 在 reload 函数中
const [matrixData, setMatrixData] = useState<AdminDesktopAssetMatrixRow[]>([]);

const reload = async () => {
  setLoading(true);
  try {
    const [sRes, kRes, bRes, mRes] = await Promise.all([
      listDesktopAssetSkins(),
      listDesktopAssetKeys(),
      getDesktopBrandingSettings(),
      getDesktopAssetsMatrix(), // 新接口
    ]);
    
    if (mRes.success && mRes.data) {
      setMatrixData(mRes.data);
    }
    
    // ... 其他逻辑
  } catch (e) {
    setErr(String(e));
  } finally {
    setLoading(false);
  }
};
```

#### 2. 渲染资源矩阵（带回退提示）
```tsx
{matrixData.map((row) => (
  <div key={row.key} className="grid-row">
    <div className="row-header">
      <div>{row.name}</div>
      <div className="text-xs text-muted">{row.key}</div>
    </div>
    
    {['', 'white', 'dark'].map((skin) => {
      const cell = row.cells[skin];
      const isFallback = cell?.isFallback ?? false;
      const url = cell?.url;
      
      return (
        <div
          key={skin}
          className={cn(
            'cell',
            isFallback && 'border-dashed border-yellow-500/40'
          )}
          title={isFallback ? '使用默认资源' : url || ''}
        >
          {url ? (
            <img src={url} alt={row.key} onError={() => handleImageError(row.key, skin)} />
          ) : (
            <div className="text-red-400">缺失</div>
          )}
          
          {isFallback && (
            <div className="text-xs text-yellow-600">回退</div>
          )}
        </div>
      );
    })}
  </div>
))}
```

#### 3. 上传时移除扩展名
```tsx
const chooseUpload = (skin: string | null, keyRaw: string) => {
  // 移除扩展名
  let key = keyRaw.trim().toLowerCase();
  if (key.includes('.')) {
    key = key.substring(0, key.lastIndexOf('.'));
  }
  
  setUploadTarget({ skin, key, mode: 'matrix' });
  fileRef.current?.click();
};
```

#### 4. 品牌配置 key 输入
```tsx
// 确保 brandingIconKey 和 brandingBgKey 不包含扩展名
const handleBrandingKeyChange = (field: 'icon' | 'bg', value: string) => {
  let key = value.trim().toLowerCase();
  if (key.includes('.')) {
    key = key.substring(0, key.lastIndexOf('.'));
  }
  
  if (field === 'icon') {
    setBrandingIconKey(key);
  } else {
    setBrandingBgKey(key);
  }
};
```

## 关键约束

1. **Key 不含扩展名**：所有 key 必须是纯业务标识（如 `bg`、`login_icon`）
2. **后端自动添加扩展名**：根据上传文件类型自动添加 `.png`、`.mp4` 等
3. **前端使用 URL**：不再自己拼接，直接使用后端返回的完整 URL
4. **回退逻辑在后端**：前端只需显示 `isFallback` 标识

## 默认资源配置

由于用户会清空所有数据，需要在 Admin 后台创建以下默认资源：

### 必需的 Key
- `bg` - 登录背景（默认）
- `login_icon` - 登录图标（默认）
- `load` - 加载动画
- `start_load` - 冷启动加载

### 可选的 Skin
- `white` - 白天皮肤
- `dark` - 黑夜皮肤

### 上传顺序
1. 创建 key：`bg`、`login_icon`、`load`、`start_load`
2. 创建 skin：`white`、`dark`
3. 上传默认资源（不选 skin）
4. 上传特定 skin 资源（可选）

## 测试清单

- [ ] 上传 PNG 图片到默认 -> 所有 skin 列显示相同图片（回退）
- [ ] 上传 MP4 到 dark -> dark 列显示视频，其他列显示默认图片
- [ ] 上传 login_icon 后，Desktop 登录页正确显示
- [ ] 上传 bg.mp4 后，Desktop 登录页播放视频背景
- [ ] 品牌配置修改后，Desktop 端立即生效（需刷新/重启）

## 常见问题

**Q: 为什么上传后显示"dark/bg.png 不可用"？**
A: 因为上传的是 `bg.mp4`，但前端仍用 `bg.png` 拼接。新系统中后端会返回正确的 URL。

**Q: Key 中可以包含 `.` 吗？**
A: 不建议。如果包含（如 `start_load.gif`），会被当作"带扩展名"的旧格式处理。新 key 应该用下划线（`start_load`）。

**Q: 如何区分图片和视频？**
A: 后端从文件扩展名自动识别。前端根据 URL 中的扩展名判断（`.mp4`/`.webm`/`.mov` = 视频）。

