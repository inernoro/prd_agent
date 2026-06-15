import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, Loader2, Star, Trash2, RefreshCw, AlertCircle, Plus, Upload } from 'lucide-react';
import { Button } from '@/components/design/Button';
import {
  generateCcasEquipment,
  uploadCcasEquipment,
  listCcasEquipment,
  toggleCcasEquipmentFavorite,
  deleteCcasEquipment,
} from '@/services';
import type { CcasEquipmentAsset, CcasMeta } from '@/services';
import { toast } from '@/lib/toast';

interface Props {
  meta: CcasMeta;
}

const COMMON_EQUIPMENT_TYPES = [
  '裹包机', '龙门架', '工业相机', '工控机', '共享屏幕',
  '灌装车间', '箱码垛工位', '传送带', '电柜', '墙体',
  '贴标机', '装箱机', '托盘', '机械臂', '条码扫码枪',
];

export function CcasEquipmentTab({ meta }: Props) {
  const [equipmentType, setEquipmentType] = useState('');
  const [styleKey, setStyleKey] = useState(meta.equipmentStyles[0]?.key ?? 'isometric-3d');
  const [extraPrompt, setExtraPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadNote, setUploadNote] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<CcasEquipmentAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterStyle, setFilterStyle] = useState<string>('');
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    const res = await listCcasEquipment({
      styleKey: filterStyle || undefined,
      favoriteOnly: favoriteOnly || undefined,
      pageSize: 60,
    });
    setLoading(false);
    if (res.success && res.data) {
      setItems(res.data.items);
    } else {
      setError(res.error?.message || '加载失败');
    }
  }, [filterStyle, favoriteOnly]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  const onGenerate = useCallback(async () => {
    const t = equipmentType.trim();
    if (!t) {
      toast.error('请输入设备类型');
      return;
    }
    setGenerating(true);
    setError(null);
    const res = await generateCcasEquipment({
      equipmentType: t,
      styleKey,
      extraPrompt: extraPrompt.trim() || undefined,
    });
    setGenerating(false);
    if (res.success && res.data) {
      toast.success(`已生成「${t}」素材`);
      setItems((prev) => [res.data!.asset, ...prev]);
    } else {
      setError(res.error?.message || '生成失败');
      toast.error(res.error?.message || '生成失败');
    }
  }, [equipmentType, styleKey, extraPrompt]);

  const onPickUploadFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('仅支持图片文件（jpg / png / webp / gif）');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error('图片不能超过 10MB');
      return;
    }
    setUploadFile(file);
    setError(null);
  }, []);

  const onUpload = useCallback(async () => {
    const t = equipmentType.trim();
    if (!t) {
      toast.error('请输入设备类型');
      return;
    }
    if (!uploadFile) {
      toast.error('请选择要上传的图片');
      return;
    }
    setUploading(true);
    setError(null);
    const res = await uploadCcasEquipment(uploadFile, {
      equipmentType: t,
      note: uploadNote.trim() || undefined,
    });
    setUploading(false);
    if (res.success && res.data) {
      toast.success(`已上传「${t}」素材`);
      setItems((prev) => [res.data!.asset, ...prev]);
      setUploadFile(null);
      setUploadNote('');
    } else {
      setError(res.error?.message || '上传失败');
      toast.error(res.error?.message || '上传失败');
    }
  }, [equipmentType, uploadFile, uploadNote]);

  const onToggleFav = useCallback(async (id: string, current: boolean) => {
    const res = await toggleCcasEquipmentFavorite(id, !current);
    if (res.success) {
      setItems((prev) => prev.map((x) => (x.id === id ? { ...x, isFavorite: !current } : x)));
    }
  }, []);

  const onDelete = useCallback(async (id: string) => {
    if (!confirm('确认删除这张素材？')) return;
    const res = await deleteCcasEquipment(id);
    if (res.success) {
      setItems((prev) => prev.filter((x) => x.id !== id));
      toast.success('已删除');
    } else {
      toast.error(res.error?.message || '删除失败');
    }
  }, []);

  return (
    <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-4 overflow-hidden">
      {/* 左：生成表单 */}
      <div className="flex flex-col gap-3 min-h-0 overflow-y-auto pr-1" style={{ overscrollBehavior: 'contain' }}>
        <section className="rounded-lg border border-white/10 bg-white/5 p-4">
          <h2 className="text-sm font-medium text-white mb-3 flex items-center gap-1.5">
            <Plus className="w-4 h-4" /> 生成新素材
          </h2>

          <label className="block text-xs text-white/65 mb-1">设备类型 <span className="text-red-400/80">*</span></label>
          <input
            list="ccas-eq-suggest"
            value={equipmentType}
            onChange={(e) => setEquipmentType(e.target.value)}
            placeholder="如：裹包机 / 工业相机"
            className="w-full mb-2 rounded-md bg-black/30 border border-white/15 px-3 py-1.5 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-amber-400/60"
          />
          <datalist id="ccas-eq-suggest">
            {COMMON_EQUIPMENT_TYPES.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>

          <label className="block text-xs text-white/65 mb-1">风格预设</label>
          <div className="grid grid-cols-2 gap-1.5 mb-2">
            {meta.equipmentStyles.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setStyleKey(s.key)}
                className={`text-left rounded-md border px-2 py-1.5 text-xs transition ${
                  styleKey === s.key
                    ? 'border-amber-400/60 bg-amber-500/10 text-white'
                    : 'border-white/10 bg-white/5 text-white/70 hover:bg-white/10'
                }`}
                title={s.promptHint}
              >
                {s.label}
              </button>
            ))}
          </div>

          <label className="block text-xs text-white/65 mb-1">额外提示词（可选）</label>
          <textarea
            value={extraPrompt}
            onChange={(e) => setExtraPrompt(e.target.value)}
            rows={3}
            placeholder="如：白色机身、银色金属支架、配 4 个相机头"
            className="w-full mb-3 rounded-md bg-black/30 border border-white/15 px-3 py-1.5 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-amber-400/60"
          />

          <Button onClick={onGenerate} disabled={generating || !equipmentType.trim()} className="!h-9 !w-full !text-xs">
            {generating ? (
              <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> 生成中…</>
            ) : (
              <><Sparkles className="w-3.5 h-3.5 mr-1" /> 生成</>
            )}
          </Button>

          {error && (
            <div className="mt-2 text-xs text-red-300/90 flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5" /> {error}
            </div>
          )}

          <div className="mt-3 text-[11px] text-white/40 leading-relaxed">
            提示：生成的素材保存在你的私人库中，可在「流程图」Tab 选用。模型选择由后台模型池决定。
          </div>
        </section>

        <section className="rounded-lg border border-white/10 bg-white/5 p-4">
          <h2 className="text-sm font-medium text-white mb-3 flex items-center gap-1.5">
            <Upload className="w-4 h-4" /> 上传本地图片
          </h2>

          <p className="text-[11px] text-white/45 mb-2 leading-relaxed">
            有现场实拍或设计稿时可直接上传，设备类型与上方共用；流程图会按设备名自动匹配。
          </p>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            className="hidden"
            onChange={onPickUploadFile}
          />

          <Button
            variant="ghost"
            onClick={() => fileInputRef.current?.click()}
            className="!h-8 !w-full !text-xs !mb-2"
          >
            {uploadFile ? `已选：${uploadFile.name}` : '选择图片（≤ 10MB）'}
          </Button>

          <label className="block text-xs text-white/65 mb-1">备注（可选）</label>
          <textarea
            value={uploadNote}
            onChange={(e) => setUploadNote(e.target.value)}
            rows={2}
            placeholder="如：石湾 2 号线现场实拍"
            className="w-full mb-3 rounded-md bg-black/30 border border-white/15 px-3 py-1.5 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-amber-400/60"
          />

          <Button
            onClick={onUpload}
            disabled={uploading || !equipmentType.trim() || !uploadFile}
            className="!h-9 !w-full !text-xs"
          >
            {uploading ? (
              <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> 上传中…</>
            ) : (
              <><Upload className="w-3.5 h-3.5 mr-1" /> 上传入库</>
            )}
          </Button>
        </section>
      </div>

      {/* 右：素材网格 */}
      <div className="flex flex-col min-h-0">
        <div className="shrink-0 flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-1.5 text-xs text-white/55">
            <span>共 {items.length} 张</span>
            <select
              value={filterStyle}
              onChange={(e) => setFilterStyle(e.target.value)}
              className="rounded bg-black/30 border border-white/15 px-1.5 py-0.5 text-[11px] text-white"
            >
              <option value="">全部风格</option>
              {meta.equipmentStyles.map((s) => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
            </select>
            <label className="inline-flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={favoriteOnly}
                onChange={(e) => setFavoriteOnly(e.target.checked)}
              />
              仅显示收藏
            </label>
          </div>
          <Button variant="ghost" onClick={loadList} className="!h-7 !px-2 !text-[11px]">
            <RefreshCw className="w-3 h-3 mr-1" /> 刷新
          </Button>
        </div>

        <div
          className="flex-1 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3 content-start"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', paddingRight: 4 }}
        >
          {loading && items.length === 0 ? (
            <div className="col-span-full text-center text-sm text-white/40 py-12">加载中…</div>
          ) : items.length === 0 ? (
            <div className="col-span-full text-center text-sm text-white/40 py-12">
              暂无素材，去左侧生成或上传第一张
            </div>
          ) : (
            items.map((it) => (
              <div
                key={it.id}
                className="rounded-lg border border-white/10 bg-black/30 overflow-hidden flex flex-col"
              >
                <div className="aspect-square bg-black/50 relative">
                  <img src={it.url} alt={it.equipmentType} className="w-full h-full object-contain" loading="lazy" />
                  <div className="absolute top-1.5 right-1.5 flex gap-1">
                    <button
                      type="button"
                      onClick={() => onToggleFav(it.id, it.isFavorite)}
                      className="p-1 rounded bg-black/40 hover:bg-black/60"
                      title={it.isFavorite ? '取消收藏' : '收藏'}
                    >
                      <Star className={`w-3.5 h-3.5 ${it.isFavorite ? 'fill-amber-400 text-amber-400' : 'text-white/60'}`} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(it.id)}
                      className="p-1 rounded bg-black/40 hover:bg-red-500/40"
                      title="删除"
                    >
                      <Trash2 className="w-3.5 h-3.5 text-white/60" />
                    </button>
                  </div>
                </div>
                <div className="px-2 py-1.5 text-[11px] text-white/70 flex items-center justify-between">
                  <span className="truncate" title={it.equipmentType}>{it.equipmentType}</span>
                  <span className="text-white/35 ml-1 shrink-0">
                    {meta.equipmentStyles.find((s) => s.key === it.styleKey)?.label ?? it.styleKey}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
