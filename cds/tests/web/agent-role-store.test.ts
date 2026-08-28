/**
 * 角色 store 的「默认值不许冒充声明」契约。
 *
 * 这条守卫的由来：任务地图按角色排序并标「某某常用」。如果读不出「用户到底
 * 选没选过」，一个从没声明过角色的开发第一次打开面板，会看到按产品经理排序、
 * 标着「产品经理常用」的任务清单——用默认值编了一个他没说过的身份。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_AGENT_ROLE_SELECTION,
  readAgentRoleSelection,
  subscribeAgentRoleSelection,
  writeAgentRoleSelection,
} from '../../web/src/lib/agent-role-store';

function installStorage(seed?: string): void {
  const store = new Map<string, string>();
  if (seed !== undefined) store.set('cds.agent.role-selection.v1', seed);
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    },
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
}

describe('角色 store', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('从未选过时 declared 为 false，默认值不算声明', () => {
    installStorage();
    const selection = readAgentRoleSelection();
    expect(selection.declared).toBe(false);
    expect(selection).toEqual(DEFAULT_AGENT_ROLE_SELECTION);
  });

  it('选过之后 declared 为 true，且读回用户选的角色', () => {
    installStorage(JSON.stringify({ roleId: 'dev', experienceId: 'experienced' }));
    const selection = readAgentRoleSelection();
    expect(selection.declared).toBe(true);
    expect(selection.roleId).toBe('dev');
    expect(selection.experienceId).toBe('experienced');
  });

  it('默认角色恰好是 pm 时也能和「真的选了 pm」区分开', () => {
    installStorage();
    expect(readAgentRoleSelection().declared).toBe(false);

    installStorage(JSON.stringify({ roleId: 'pm', experienceId: 'newcomer' }));
    const chosen = readAgentRoleSelection();
    expect(chosen.roleId).toBe(DEFAULT_AGENT_ROLE_SELECTION.roleId);
    // 角色一样，但一个是默认、一个是声明，必须分得开。
    expect(chosen.declared).toBe(true);
  });

  it('写入即声明：调用方传 declared:false 也会被存成已声明', () => {
    installStorage();
    writeAgentRoleSelection({ roleId: 'qa', experienceId: 'newcomer', declared: false });
    const selection = readAgentRoleSelection();
    expect(selection.roleId).toBe('qa');
    expect(selection.declared).toBe(true);
  });

  it('脏记录退回未声明，而不是当成一次声明', () => {
    installStorage('{ 这不是 JSON');
    expect(readAgentRoleSelection().declared).toBe(false);

    installStorage(JSON.stringify({ roleId: 'ceo', experienceId: 'newcomer' }));
    expect(readAgentRoleSelection().declared).toBe(false);
  });

  it('存储不可用时不抛异常，退回未声明', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => { throw new Error('storage disabled'); },
        setItem: () => { throw new Error('storage disabled'); },
      },
      dispatchEvent: () => { throw new Error('no CustomEvent'); },
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    expect(readAgentRoleSelection().declared).toBe(false);
    expect(() => writeAgentRoleSelection({ roleId: 'dev', experienceId: 'newcomer', declared: true })).not.toThrow();
  });

  it('订阅能拿到取消订阅函数并正常摘除监听', () => {
    installStorage();
    const unsubscribe = subscribeAgentRoleSelection(() => {});
    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe()).not.toThrow();
  });
});
