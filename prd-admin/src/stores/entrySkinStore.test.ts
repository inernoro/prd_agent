// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { useEntrySkinStore } from './entrySkinStore';
import { beginEntryArrival } from '@/components/effects/entryArrival';
import { isConsciousnessArrival, markConsciousnessArrival } from '@/components/effects/ConsciousnessScene';

afterEach(() => { useEntrySkinStore.getState().setSkin('standard'); localStorage.removeItem('map-entry-skin'); });
it('初始默认不启用角色皮肤，显式选择会保存为设备偏好', () => {
  expect(useEntrySkinStore.getInitialState().skin).toBe('standard');
  useEntrySkinStore.getState().setSkin('companion');
  expect(JSON.parse(localStorage.getItem('map-entry-skin')!).state.skin).toBe('companion');
});
it('旧数据与未知皮肤回退标准工作台', async () => {
  localStorage.setItem('map-entry-skin', JSON.stringify({ state: { skin: 'unknown' }, version: 0 }));
  await useEntrySkinStore.persist.rehydrate();
  expect(useEntrySkinStore.getState().skin).toBe('standard');
});
it('切回标准皮肤会取消未消费的入场，导航立即恢复', () => {
  window.matchMedia = () => ({ matches: false }) as MediaQueryList;
  markConsciousnessArrival(); beginEntryArrival();
  expect(isConsciousnessArrival()).toBe(true);
  useEntrySkinStore.getState().setSkin('standard');
  expect(isConsciousnessArrival()).toBe(false);
  expect(document.documentElement.hasAttribute('data-entry-arriving')).toBe(false);
});
