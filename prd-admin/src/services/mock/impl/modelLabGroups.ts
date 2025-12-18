import { fail, ok, type ApiResponse } from '@/types/api';
import type { DeleteModelLabGroupContract, ListModelLabGroupsContract, ModelLabGroup, UpsertModelLabGroupContract } from '@/services/contracts/modelLabGroups';
import { db } from '@/services/mock/db';
import { sleep } from '@/services/mock/utils';

export const listModelLabGroupsMock: ListModelLabGroupsContract = async (args) => {
  await sleep(180);
  const s = (args?.search ?? '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(200, args?.limit ?? 50));
  const items = !s ? db.modelLabGroups : db.modelLabGroups.filter((g) => (g.name || '').toLowerCase().includes(s));
  return ok({ items: items.slice(0, limit) as unknown as ModelLabGroup[] });
};

export const upsertModelLabGroupMock: UpsertModelLabGroupContract = async (input) => {
  await sleep(240);
  const name = (input.name ?? '').trim();
  if (!name) return fail('CONTENT_EMPTY', '请输入分组名称') as unknown as ApiResponse<any>;

  // 同名校验（同一 mock db 下）
  const hasSameName = db.modelLabGroups.some((g) => g.name === name && g.id !== input.id);
  if (hasSameName) return fail('INVALID_FORMAT', '分组名称已存在') as unknown as ApiResponse<any>;

  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  if (input.id) {
    const cur = db.modelLabGroups.find((g) => g.id === input.id);
    if (!cur) return fail('SESSION_NOT_FOUND', '分组不存在') as unknown as ApiResponse<any>;
    cur.name = name;
    cur.models = input.models ?? [];
    cur.updatedAt = now;
    return ok(cur as unknown as ModelLabGroup);
  }

  const g = {
    id: `lg_${Date.now()}`,
    ownerAdminId: 'mock-admin',
    name,
    models: input.models ?? [],
    createdAt: now,
    updatedAt: now,
  };
  db.modelLabGroups.unshift(g);
  return ok(g as unknown as ModelLabGroup);
};

export const deleteModelLabGroupMock: DeleteModelLabGroupContract = async (id) => {
  await sleep(180);
  const idx = db.modelLabGroups.findIndex((g) => g.id === id);
  if (idx === -1) return fail('SESSION_NOT_FOUND', '分组不存在') as unknown as ApiResponse<any>;
  db.modelLabGroups.splice(idx, 1);
  return ok(true);
};


