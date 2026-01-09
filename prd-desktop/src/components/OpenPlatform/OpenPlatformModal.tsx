import { useEffect, useMemo, useState } from 'react';
import { invoke, isTauri } from '../../lib/tauri';
import { useOpenPlatformStore } from '../../stores/openPlatformStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useGroupListStore } from '../../stores/groupListStore';
import type { ApiResponse, Group } from '../../types';

type OpenPlatformApiKeyDto = {
  id: string;
  ownerUserId: string;
  name?: string | null;
  keyPrefix: string;
  allowedGroupIds: string[];
  createdAt: string;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
};

type CreateOpenPlatformApiKeyResponse = {
  apiKey: string;
  key: OpenPlatformApiKeyDto;
};

async function copyText(text: string) {
  const t = String(text ?? '');
  if (!t) return;
  if (isTauri()) {
    try {
      const mod = await import('@tauri-apps/plugin-clipboard-manager');
      await mod.writeText(t);
      return;
    } catch {
      // fallback below
    }
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(t);
    return;
  }
  throw new Error('clipboard API 不可用');
}

function joinBaseUrl(base: string, path: string) {
  const b = base.replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '');
  return `${b}/${p}`;
}

export default function OpenPlatformModal() {
  const open = useOpenPlatformStore((s) => s.isOpen);
  const close = useOpenPlatformStore((s) => s.close);
  const apiBaseUrl = useSettingsStore((s) => s.config?.apiBaseUrl ?? 'https://pa.759800.com');
  const groups = useGroupListStore((s) => s.groups);

  const baseUrl = useMemo(() => joinBaseUrl(apiBaseUrl || 'https://pa.759800.com', '/api/v1/open-platform'), [apiBaseUrl]);

  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<OpenPlatformApiKeyDto[]>([]);
  const [error, setError] = useState<string>('');

  const [createName, setCreateName] = useState('');
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [createdKeyOnce, setCreatedKeyOnce] = useState<string>('');
  const [creating, setCreating] = useState(false);

  const groupNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of groups) map.set(g.groupId, g.groupName);
    return map;
  }, [groups]);

  const availableGroups: Group[] = useMemo(() => {
    // 仅允许授权自己已加入的群组（与后端约束一致）
    return groups;
  }, [groups]);

  const loadKeys = async () => {
    setError('');
    setLoading(true);
    try {
      const resp = await invoke<ApiResponse<OpenPlatformApiKeyDto[]>>('open_platform_list_keys');
      if (resp.success && resp.data) {
        setItems(resp.data);
      } else {
        setItems([]);
        setError(resp.error?.message || '加载失败');
      }
    } catch (e) {
      setItems([]);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setCreatedKeyOnce('');
    setCreateName('');
    // 默认勾选第一个群（如果有）
    setSelectedGroupIds((prev) => {
      if (prev.length > 0) return prev;
      const first = availableGroups[0]?.groupId;
      return first ? [first] : [];
    });
    void loadKeys();
  }, [open]);

  const selectedGroupCount = selectedGroupIds.length;
  const canCreate = selectedGroupCount > 0 && !creating;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={close} />

      <div className="relative w-full max-w-2xl mx-4 ui-glass-modal max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-black/10 dark:border-white/10 sticky top-0 ui-glass-bar z-10">
          <div>
            <div className="text-lg font-semibold text-text-primary">开放平台</div>
            <div className="mt-1 text-sm text-text-secondary">
              对外提供 OpenAI 兼容接口（按 Key + 群组授权隔离）
            </div>
          </div>
          <button
            onClick={close}
            className="p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
            aria-label="关闭"
            title="关闭"
          >
            <svg className="w-5 h-5 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 space-y-5">
          <div className="p-3 ui-glass-panel space-y-2">
            <div className="text-xs text-text-secondary">Base URL</div>
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-mono text-text-primary break-all">{baseUrl}</div>
              <button
                type="button"
                className="px-3 py-1.5 text-xs font-medium bg-black/5 hover:bg-black/10 text-text-secondary rounded-lg transition-colors dark:bg-white/10 dark:hover:bg-white/20 dark:text-white/80"
                onClick={async () => {
                  try {
                    await copyText(baseUrl);
                    alert('已复制');
                  } catch (e) {
                    alert(String(e));
                  }
                }}
              >
                复制
              </button>
            </div>
            <div className="text-xs text-text-secondary">
              调用示例：<span className="font-mono">POST {baseUrl}/v1/chat/completions</span>，Header 需要{' '}
              <span className="font-mono">Authorization: Bearer sk_prd_...</span> 与 <span className="font-mono">X-Group-Id</span>
            </div>
          </div>

          {/* 创建 Key */}
          <div className="space-y-3">
            <div className="text-sm font-medium text-text-secondary">创建 Key</div>
            <div className="p-3 ui-glass-panel space-y-3">
              <div className="space-y-1">
                <div className="text-xs text-text-secondary">名称（可选）</div>
                <input
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="例如：外部机器人 / 客服对接 / CI 检查"
                  className="w-full px-4 py-3 ui-control transition-colors"
                  maxLength={64}
                  disabled={creating}
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-xs text-text-secondary">授权群组（至少 1 个）</div>
                  <div className="text-xs text-text-secondary">已选 {selectedGroupCount}</div>
                </div>
                <div className="max-h-44 overflow-y-auto rounded-lg border border-black/10 dark:border-white/10">
                  {availableGroups.length === 0 ? (
                    <div className="p-3 text-sm text-text-secondary">你还没有加入任何群组，无法创建开放平台 Key。</div>
                  ) : (
                    <div className="divide-y divide-black/10 dark:divide-white/10">
                      {availableGroups.map((g) => {
                        const checked = selectedGroupIds.includes(g.groupId);
                        return (
                          <label key={g.groupId} className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={creating}
                              onChange={(e) => {
                                const on = e.target.checked;
                                setSelectedGroupIds((prev) => {
                                  if (on) return Array.from(new Set([...prev, g.groupId]));
                                  return prev.filter((x) => x !== g.groupId);
                                });
                              }}
                            />
                            <div className="min-w-0">
                              <div className="text-sm text-text-primary truncate">{g.groupName}</div>
                              <div className="text-xs text-text-secondary font-mono truncate">{g.groupId}</div>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  className="px-3 py-1.5 text-xs font-medium bg-black/5 hover:bg-black/10 text-text-secondary rounded-lg transition-colors dark:bg-white/10 dark:hover:bg-white/20 dark:text-white/80 disabled:opacity-50"
                  disabled={creating}
                  onClick={() => {
                    setCreateName('');
                    setSelectedGroupIds([]);
                    setCreatedKeyOnce('');
                  }}
                >
                  重置
                </button>
                <button
                  type="button"
                  className="px-3 py-1.5 text-xs font-medium bg-gradient-to-r from-cyan-500 to-purple-500 text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
                  disabled={!canCreate}
                  onClick={async () => {
                    setError('');
                    setCreatedKeyOnce('');
                    setCreating(true);
                    try {
                      const resp = await invoke<ApiResponse<CreateOpenPlatformApiKeyResponse>>('open_platform_create_key', {
                        name: createName.trim() || null,
                        groupIds: selectedGroupIds,
                      });
                      if (resp.success && resp.data) {
                        setCreatedKeyOnce(resp.data.apiKey);
                        await loadKeys();
                      } else {
                        setError(resp.error?.message || '创建失败');
                      }
                    } catch (e) {
                      setError(String(e));
                    } finally {
                      setCreating(false);
                    }
                  }}
                >
                  {creating ? '创建中...' : '创建'}
                </button>
              </div>

              {createdKeyOnce ? (
                <div className="p-3 rounded-lg border border-emerald-500/25 bg-emerald-500/10">
                  <div className="text-xs text-emerald-700 dark:text-emerald-200">已创建（仅此处展示一次，请立即复制保存）</div>
                  <div className="mt-1 flex items-start justify-between gap-3">
                    <div className="text-sm font-mono text-text-primary break-all">{createdKeyOnce}</div>
                    <button
                      type="button"
                      className="px-3 py-1.5 text-xs font-medium bg-emerald-500/25 hover:bg-emerald-500/35 text-emerald-50 rounded-lg transition-colors"
                      onClick={async () => {
                        try {
                          await copyText(createdKeyOnce);
                          alert('已复制');
                        } catch (e) {
                          alert(String(e));
                        }
                      }}
                    >
                      复制 Key
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {/* Key 列表 */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-text-secondary">我的 Keys</div>
              <button
                type="button"
                className="px-3 py-1.5 text-xs font-medium bg-black/5 hover:bg-black/10 text-text-secondary rounded-lg transition-colors dark:bg-white/10 dark:hover:bg-white/20 dark:text-white/80 disabled:opacity-50"
                disabled={loading}
                onClick={() => void loadKeys()}
              >
                {loading ? '刷新中...' : '刷新'}
              </button>
            </div>

            <div className="rounded-lg border border-black/10 dark:border-white/10 overflow-hidden">
              {loading ? (
                <div className="p-4 text-sm text-text-secondary">加载中...</div>
              ) : items.length === 0 ? (
                <div className="p-4 text-sm text-text-secondary">暂无 Key</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-black/5 dark:bg-white/10">
                    <tr>
                      <th className="text-left px-3 py-2 text-text-secondary font-medium">名称</th>
                      <th className="text-left px-3 py-2 text-text-secondary font-medium">Key</th>
                      <th className="text-left px-3 py-2 text-text-secondary font-medium">授权群组</th>
                      <th className="text-right px-3 py-2 text-text-secondary font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-black/10 dark:divide-white/10">
                    {items.map((k) => {
                      const revoked = Boolean(k.revokedAt);
                      const groupNames = (k.allowedGroupIds ?? []).map((id) => groupNameById.get(id) || id);
                      return (
                        <tr key={k.id} className="hover:bg-black/5 dark:hover:bg-white/5">
                          <td className="px-3 py-2">
                            <div className="text-text-primary font-medium">{k.name || '（未命名）'}</div>
                            <div className="text-xs text-text-secondary">{revoked ? '已撤销' : '可用'}</div>
                          </td>
                          <td className="px-3 py-2">
                            <div className="font-mono text-text-primary break-all">{k.keyPrefix}***</div>
                            <div className="text-xs text-text-secondary font-mono">{k.id}</div>
                          </td>
                          <td className="px-3 py-2">
                            <div className="text-text-secondary">
                              {groupNames.length > 0 ? groupNames.slice(0, 2).join('、') : '—'}
                              {groupNames.length > 2 ? ` 等 ${groupNames.length} 个` : ''}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <div className="inline-flex items-center gap-2">
                              <button
                                type="button"
                                className="px-3 py-1.5 text-xs font-medium bg-black/5 hover:bg-black/10 text-text-secondary rounded-lg transition-colors dark:bg-white/10 dark:hover:bg-white/20 dark:text-white/80"
                                onClick={async () => {
                                  try {
                                    await copyText(`${baseUrl}/v1/chat/completions`);
                                    alert('已复制');
                                  } catch (e) {
                                    alert(String(e));
                                  }
                                }}
                                title="复制 Chat Completions URL"
                              >
                                复制接口
                              </button>
                              <button
                                type="button"
                                disabled={revoked}
                                className="px-3 py-1.5 text-xs font-medium bg-red-500/20 hover:bg-red-500/30 text-red-100 rounded-lg transition-colors disabled:opacity-50"
                                onClick={async () => {
                                  if (revoked) return;
                                  const ok = window.confirm('确认撤销该 Key？撤销后第三方将无法继续调用。');
                                  if (!ok) return;
                                  try {
                                    const resp = await invoke<ApiResponse<any>>('open_platform_revoke_key', { keyId: k.id });
                                    if (resp.success) {
                                      await loadKeys();
                                    } else {
                                      alert(resp.error?.message || '撤销失败');
                                    }
                                  } catch (e) {
                                    alert(String(e));
                                  }
                                }}
                              >
                                撤销
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {error ? (
            <div className="p-3 bg-red-500/15 border border-red-500/35 rounded-lg text-red-700 dark:text-red-200 text-sm">
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex gap-3 px-6 py-4 border-t border-black/10 dark:border-white/10 sticky bottom-0 ui-glass-bar">
          <button
            onClick={close}
            className="flex-1 py-2.5 ui-control text-text-secondary font-medium hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

