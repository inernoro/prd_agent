/**
 * 角色 store 的「默认值不许冒充声明」契约。
 *
 * 这条守卫的由来：任务地图按角色排序并标「某某常用」。如果读不出「用户到底
 * 选没选过」，一个从没声明过角色的开发第一次打开面板，会看到按产品经理排序、
 * 标着「产品经理常用」的任务清单——用默认值编了一个他没说过的身份。
 */

import { readFileSync } from 'node:fs';
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
    installStorage(JSON.stringify({ roleId: 'dev', experienceId: 'experienced', declared: true }));
    const selection = readAgentRoleSelection();
    expect(selection.declared).toBe(true);
    expect(selection.roleId).toBe('dev');
    expect(selection.experienceId).toBe('experienced');
  });

  it('默认角色恰好是 pm 时也能和「真的选了 pm」区分开', () => {
    installStorage();
    expect(readAgentRoleSelection().declared).toBe(false);

    installStorage(JSON.stringify({ roleId: 'pm', experienceId: 'newcomer', declared: true }));
    const chosen = readAgentRoleSelection();
    expect(chosen.roleId).toBe(DEFAULT_AGENT_ROLE_SELECTION.roleId);
    // 角色一样，但一个是默认、一个是声明，必须分得开。
    expect(chosen.declared).toBe(true);
  });

  it('declared 原样落盘：只改经验的写入不会把默认角色变成声明', () => {
    installStorage();
    // 向导第一步只选了经验，roleId 还停在默认值 pm。
    writeAgentRoleSelection({
      ...DEFAULT_AGENT_ROLE_SELECTION,
      experienceId: 'experienced',
    });
    const afterExperience = readAgentRoleSelection();
    expect(afterExperience.experienceId).toBe('experienced');
    // 这一步若被记成声明，任务清单会按用户从没选过的 pm 排序并标注。
    expect(afterExperience.declared).toBe(false);

    // 真的选了角色才算声明。
    writeAgentRoleSelection({ roleId: 'qa', experienceId: 'experienced', declared: true });
    const afterRole = readAgentRoleSelection();
    expect(afterRole.roleId).toBe('qa');
    expect(afterRole.declared).toBe(true);
  });

  it('缺 declared 字段的记录按未声明读回，不替用户补一个声明', () => {
    installStorage(JSON.stringify({ roleId: 'dev', experienceId: 'experienced' }));
    expect(readAgentRoleSelection().declared).toBe(false);
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

  // 上面几条只能证明 store 本身守约。真正会再犯的是调用侧：向导第一步
  // 顺手把 declared 一起带上，默认角色就又变成声明了，而且 store 的测试
  // 全绿、界面看不出来。这条盯住那两个 setter 的分工。
  it('向导：只有选角色的 setter 置 declared，选经验的不置', () => {
    const source = readFileSync(
      new URL('../../web/src/components/AgentStarterTab.tsx', import.meta.url),
      'utf8',
    );
    const setExperience = source.slice(
      source.indexOf('const setExperienceId'),
      source.indexOf('const setRoleId'),
    );
    const setRole = source.slice(
      source.indexOf('const setRoleId'),
      source.indexOf('const setRoleId') + 200,
    );
    expect(setExperience).not.toContain('declared');
    expect(setRole).toContain('declared: true');
  });

  it('订阅能拿到取消订阅函数并正常摘除监听', () => {
    installStorage();
    const unsubscribe = subscribeAgentRoleSelection(() => {});
    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe()).not.toThrow();
  });
});
