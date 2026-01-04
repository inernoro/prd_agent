import { useEffect, useMemo, useState } from 'react';
import {
  createDesktopAssetKey,
  createDesktopAssetSkin,
  deleteDesktopAssetSkin,
  listDesktopAssetKeys,
  listDesktopAssetSkins,
  updateDesktopAssetSkin,
  uploadDesktopAsset,
} from '@/services';
import type { DesktopAssetKey, DesktopAssetSkin } from '@/services/contracts/desktopAssets';

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(' ');
}

function skinLabel(name: string) {
  const s = String(name || '').trim().toLowerCase();
  if (s === 'white') return '白天';
  if (s === 'dark') return '黑夜';
  return name;
}

function buildPreviewUrl(skin: string | null, key: string) {
  const base = 'https://i.pa.759800.com';
  const k = String(key || '').trim().replace(/^\/+/, '');
  const s = String(skin || '').trim().replace(/^\/+|\/+$/g, '');
  if (!k) return '';
  if (s) return `${base}/icon/desktop/${s}/${k}`;
  return `${base}/icon/desktop/${k}`;
}

async function copyText(s: string) {
  const text = String(s || '');
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

export default function AssetsManagePage() {
  const [skins, setSkins] = useState<DesktopAssetSkin[]>([]);
  const [keys, setKeys] = useState<DesktopAssetKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const [newSkin, setNewSkin] = useState('white');
  const [newKey, setNewKey] = useState('load.gif');
  const [newKeyKind, setNewKeyKind] = useState('image');
  const [newKeyDesc, setNewKeyDesc] = useState('');

  const [uploadSkin, setUploadSkin] = useState<string>(''); // ''=默认
  const [uploadKey, setUploadKey] = useState('load.gif');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadResultUrl, setUploadResultUrl] = useState<string>('');

  const skinNames = useMemo(() => skins.filter((s) => s.enabled).map((s) => s.name), [skins]);

  const reload = async () => {
    setLoading(true);
    setErr('');
    try {
      const [sRes, kRes] = await Promise.all([listDesktopAssetSkins(), listDesktopAssetKeys()]);
      if (!sRes.success) throw new Error(sRes.error?.message || '加载 skins 失败');
      if (!kRes.success) throw new Error(kRes.error?.message || '加载 keys 失败');
      setSkins(Array.isArray(sRes.data) ? sRes.data : []);
      setKeys(Array.isArray(kRes.data) ? kRes.data : []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e || '加载失败'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const onCreateSkin = async () => {
    const name = newSkin.trim().toLowerCase();
    if (!name) return;
    setLoading(true);
    setErr('');
    try {
      const res = await createDesktopAssetSkin({ name, enabled: true });
      if (!res.success) throw new Error(res.error?.message || '创建皮肤失败');
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e || '创建失败'));
    } finally {
      setLoading(false);
    }
  };

  const onToggleSkin = async (id: string, enabled: boolean) => {
    setLoading(true);
    setErr('');
    try {
      const res = await updateDesktopAssetSkin({ id, enabled });
      if (!res.success) throw new Error(res.error?.message || '更新皮肤失败');
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e || '更新失败'));
    } finally {
      setLoading(false);
    }
  };

  const onDeleteSkin = async (id: string) => {
    const ok = window.confirm('确认删除该皮肤？（仅删除元数据，不会自动删除 COS 文件）');
    if (!ok) return;
    setLoading(true);
    setErr('');
    try {
      const res = await deleteDesktopAssetSkin({ id });
      if (!res.success) throw new Error(res.error?.message || '删除皮肤失败');
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e || '删除失败'));
    } finally {
      setLoading(false);
    }
  };

  const onCreateKey = async () => {
    const key = newKey.trim().toLowerCase();
    if (!key) return;
    setLoading(true);
    setErr('');
    try {
      const res = await createDesktopAssetKey({
        key,
        kind: newKeyKind.trim() || 'image',
        description: newKeyDesc.trim() || null,
      });
      if (!res.success) throw new Error(res.error?.message || '创建 key 失败');
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e || '创建失败'));
    } finally {
      setLoading(false);
    }
  };

  const onUpload = async () => {
    const key = uploadKey.trim().toLowerCase();
    if (!key) return;
    if (!uploadFile) {
      setErr('请先选择文件');
      return;
    }
    setLoading(true);
    setErr('');
    setUploadResultUrl('');
    try {
      const res = await uploadDesktopAsset({ skin: uploadSkin ? uploadSkin : null, key, file: uploadFile });
      if (!res.success) throw new Error(res.error?.message || '上传失败');
      setUploadResultUrl(res.data?.url || buildPreviewUrl(uploadSkin || null, key));
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e || '上传失败'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-full w-full px-6 py-5">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[20px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            Desktop 资源管理
          </div>
          <div className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
            皮肤与资源 key 只存元数据；文件上传到 COS，Desktop 按固定规则拼接 URL 预览。
          </div>
        </div>
        <button
          type="button"
          className={cn(
            'rounded-[12px] px-3 py-2 text-sm',
            'border border-white/10 hover:bg-white/5',
            loading && 'opacity-60 pointer-events-none'
          )}
          onClick={() => void reload()}
        >
          刷新
        </button>
      </div>

      {err ? (
        <div className="mt-4 rounded-[12px] px-4 py-3 text-sm" style={{ background: 'color-mix(in srgb, #ff4d4f 10%, transparent)', border: '1px solid color-mix(in srgb, #ff4d4f 35%, var(--border-subtle))', color: 'var(--text-primary)' }}>
          {err}
        </div>
      ) : null}

      <div className="mt-5 grid grid-cols-1 gap-4">
        {/* Skins */}
        <section className="rounded-[16px] p-4" style={{ background: 'var(--panel)', border: '1px solid var(--border-subtle)' }}>
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              皮肤（skins）
            </div>
            <div className="flex items-center gap-2">
              <input
                value={newSkin}
                onChange={(e) => setNewSkin(e.target.value)}
                className="h-9 px-3 rounded-[12px] bg-black/15 border border-white/10 text-sm"
                placeholder="例如 white / dark / blue"
              />
              <button
                type="button"
                className="h-9 px-3 rounded-[12px] border border-white/10 hover:bg-white/5 text-sm"
                onClick={() => void onCreateSkin()}
                disabled={loading}
              >
                新建皮肤
              </button>
            </div>
          </div>

          <div className="mt-3 overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ color: 'var(--text-muted)' }}>
                  <th className="text-left py-2">名称</th>
                  <th className="text-left py-2">标题</th>
                  <th className="text-left py-2">启用</th>
                  <th className="text-left py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {skins.map((s) => (
                  <tr key={s.id} className="border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                    <td className="py-2">{s.name}</td>
                    <td className="py-2" style={{ color: 'var(--text-muted)' }}>
                      {skinLabel(s.name)}
                    </td>
                    <td className="py-2">
                      <label className="inline-flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={s.enabled}
                          onChange={(e) => void onToggleSkin(s.id, e.target.checked)}
                        />
                        <span style={{ color: 'var(--text-muted)' }}>{s.enabled ? '是' : '否'}</span>
                      </label>
                    </td>
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          className="px-2 py-1 rounded-[10px] border border-white/10 hover:bg-white/5"
                          onClick={() => void copyText(s.name)}
                          title="复制皮肤名"
                        >
                          复制
                        </button>
                        <button
                          type="button"
                          className="px-2 py-1 rounded-[10px] border border-white/10 hover:bg-white/5"
                          onClick={() => void onDeleteSkin(s.id)}
                          title="删除皮肤"
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {skins.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-3" style={{ color: 'var(--text-muted)' }}>
                      暂无皮肤
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        {/* Keys */}
        <section className="rounded-[16px] p-4" style={{ background: 'var(--panel)', border: '1px solid var(--border-subtle)' }}>
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              资源 key（keys）
            </div>
            <div className="flex items-center gap-2">
              <input
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                className="h-9 px-3 rounded-[12px] bg-black/15 border border-white/10 text-sm w-[240px]"
                placeholder="例如 load.gif / login/logo.svg"
              />
              <select
                value={newKeyKind}
                onChange={(e) => setNewKeyKind(e.target.value)}
                className="h-9 px-3 rounded-[12px] bg-black/15 border border-white/10 text-sm"
              >
                <option value="image">image</option>
                <option value="audio">audio</option>
                <option value="video">video</option>
                <option value="other">other</option>
              </select>
              <input
                value={newKeyDesc}
                onChange={(e) => setNewKeyDesc(e.target.value)}
                className="h-9 px-3 rounded-[12px] bg-black/15 border border-white/10 text-sm w-[260px]"
                placeholder="描述（可选）"
              />
              <button
                type="button"
                className="h-9 px-3 rounded-[12px] border border-white/10 hover:bg-white/5 text-sm"
                onClick={() => void onCreateKey()}
                disabled={loading}
              >
                新建 key
              </button>
            </div>
          </div>

          <div className="mt-3 overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ color: 'var(--text-muted)' }}>
                  <th className="text-left py-2">key</th>
                  <th className="text-left py-2">kind</th>
                  <th className="text-left py-2">描述</th>
                  <th className="text-left py-2">默认地址</th>
                  <th className="text-left py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => {
                  const url = buildPreviewUrl(null, k.key);
                  return (
                    <tr key={k.id} className="border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                      <td className="py-2">{k.key}</td>
                      <td className="py-2" style={{ color: 'var(--text-muted)' }}>
                        {k.kind}
                      </td>
                      <td className="py-2" style={{ color: 'var(--text-muted)' }}>
                        {k.description || '-'}
                      </td>
                      <td className="py-2">
                        <a className="underline text-sm" href={url} target="_blank" rel="noreferrer" title={url}>
                          查看
                        </a>
                      </td>
                      <td className="py-2">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            className="px-2 py-1 rounded-[10px] border border-white/10 hover:bg-white/5"
                            onClick={() => void copyText(url)}
                          >
                            复制地址
                          </button>
                          <button
                            type="button"
                            className="px-2 py-1 rounded-[10px] border border-white/10 hover:bg-white/5"
                            onClick={() => {
                              setUploadKey(k.key);
                              setUploadSkin('');
                              setUploadResultUrl('');
                              window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
                            }}
                            title="填充到上传表单"
                          >
                            一键替换
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {keys.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-3" style={{ color: 'var(--text-muted)' }}>
                      暂无 key
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        {/* Upload */}
        <section className="rounded-[16px] p-4" style={{ background: 'var(--panel)', border: '1px solid var(--border-subtle)' }}>
          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            上传/替换（覆盖写）
          </div>
          <div className="mt-3 grid grid-cols-12 gap-3 items-end">
            <div className="col-span-3">
              <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
                皮肤
              </div>
              <select
                value={uploadSkin}
                onChange={(e) => setUploadSkin(e.target.value)}
                className="h-9 w-full px-3 rounded-[12px] bg-black/15 border border-white/10 text-sm"
              >
                <option value="">默认（base）</option>
                {skinNames.map((s) => (
                  <option key={s} value={s}>
                    {s}（{skinLabel(s)}）
                  </option>
                ))}
              </select>
            </div>
            <div className="col-span-4">
              <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
                key
              </div>
              <input
                value={uploadKey}
                onChange={(e) => setUploadKey(e.target.value)}
                className="h-9 w-full px-3 rounded-[12px] bg-black/15 border border-white/10 text-sm"
                placeholder="例如 load.gif"
              />
            </div>
            <div className="col-span-3">
              <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
                文件
              </div>
              <input
                type="file"
                onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
                className="h-9 w-full text-sm"
              />
            </div>
            <div className="col-span-2 flex gap-2">
              <button
                type="button"
                className={cn('h-9 px-3 rounded-[12px] border border-white/10 hover:bg-white/5 text-sm', loading && 'opacity-60 pointer-events-none')}
                onClick={() => void onUpload()}
              >
                上传
              </button>
              <a
                className="h-9 px-3 rounded-[12px] border border-white/10 hover:bg-white/5 text-sm inline-flex items-center"
                href={buildPreviewUrl(uploadSkin || null, uploadKey)}
                target="_blank"
                rel="noreferrer"
                title="一键查看（按固定规则拼接）"
              >
                一键查看
              </a>
            </div>
          </div>

          {uploadResultUrl ? (
            <div className="mt-3 flex items-center justify-between rounded-[12px] px-3 py-2" style={{ background: 'color-mix(in srgb, var(--accent-gold) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-gold) 30%, var(--border-subtle))' }}>
              <div className="min-w-0">
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  上传成功（可复制地址）
                </div>
                <div className="text-sm truncate" title={uploadResultUrl} style={{ color: 'var(--text-primary)' }}>
                  {uploadResultUrl}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="px-2 py-1 rounded-[10px] border border-white/10 hover:bg-white/5 text-sm"
                  onClick={() => void copyText(uploadResultUrl)}
                >
                  复制地址
                </button>
              </div>
            </div>
          ) : null}
        </section>

        {/* Preview Grid */}
        <section className="rounded-[16px] p-4" style={{ background: 'var(--panel)', border: '1px solid var(--border-subtle)' }}>
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              预览矩阵（多少皮肤多少列）
            </div>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              悬浮可见源站地址；缺失会显示“缺失/不可用”
            </div>
          </div>

          <div className="mt-3 overflow-auto">
            <div
              className="grid"
              style={{
                gridTemplateColumns: `220px repeat(${1 + skinNames.length}, minmax(240px, 1fr))`,
              }}
            >
              <div className="sticky top-0 z-10 py-2" style={{ background: 'var(--panel)', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>
                资源 key
              </div>
              <div className="sticky top-0 z-10 py-2 px-2 font-semibold" style={{ background: 'var(--panel)', color: 'var(--text-primary)', borderBottom: '1px solid var(--border-subtle)' }}>
                默认
              </div>
              {skinNames.map((s) => (
                <div key={s} className="sticky top-0 z-10 py-2 px-2 font-semibold" style={{ background: 'var(--panel)', color: 'var(--text-primary)', borderBottom: '1px solid var(--border-subtle)' }}>
                  {s}（{skinLabel(s)}）
                </div>
              ))}

              {keys.map((k) => (
                <PreviewRow key={k.id} assetKey={k.key} skins={skinNames} />
              ))}
              {keys.length === 0 ? (
                <div className="py-3" style={{ color: 'var(--text-muted)' }}>
                  先创建 key，才会显示预览矩阵
                </div>
              ) : null}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function PreviewRow(props: { assetKey: string; skins: string[] }) {
  const { assetKey, skins } = props;
  return (
    <>
      <div className="py-3 pr-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="text-sm" style={{ color: 'var(--text-primary)' }}>
          {assetKey}
        </div>
        <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
          {assetKey.includes('/') ? 'path' : 'file'}
        </div>
      </div>
      <PreviewCell skin={null} assetKey={assetKey} />
      {skins.map((s) => (
        <PreviewCell key={s} skin={s} assetKey={assetKey} />
      ))}
    </>
  );
}

function PreviewCell(props: { skin: string | null; assetKey: string }) {
  const { skin, assetKey } = props;
  const [bad, setBad] = useState(false);
  const url = buildPreviewUrl(skin, assetKey);
  return (
    <div className="py-3 px-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      <div className={cn('rounded-[12px] p-2 border', bad ? 'border-red-500/40' : 'border-white/10')} title={url}>
        <img
          src={url}
          alt=""
          onError={() => setBad(true)}
          onLoad={() => setBad(false)}
          style={{ width: 80, height: 80, objectFit: 'contain', display: 'block' }}
        />
      </div>
      <div className={cn('mt-2 text-xs', bad ? 'text-red-400' : '')} style={{ color: bad ? undefined : 'var(--text-muted)' }}>
        {bad ? '缺失/不可用' : '正常'}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          className="px-2 py-1 rounded-[10px] border border-white/10 hover:bg-white/5 text-xs"
          onClick={() => void copyText(url)}
          title="复制源站地址"
        >
          复制
        </button>
        <a className="text-xs underline" href={url} target="_blank" rel="noreferrer">
          查看
        </a>
      </div>
    </div>
  );
}


