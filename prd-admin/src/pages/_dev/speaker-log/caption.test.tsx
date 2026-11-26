// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpeakerLogScreen } from './SpeakerLogPrototype';
import { screenAt } from './model';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const noop = () => undefined;
const actions = { jump: noop, setRate: noop, replay: noop, toggleReduce: noop, setTheme: noop };

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('字幕入场', () => {
  it('下一帧仍保留新字，满 160 毫秒才摘掉', async () => {
    let now = 5_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const paint = (ms: number) => {
      root.render(
        <SpeakerLogScreen
          model={screenAt({ script: 'sample', ms, reduceMotion: false, playing: true })}
          actions={actions}
        />,
      );
    };
    const chars = () => [...container.querySelectorAll('.cap-new')].map((node) => node.textContent);
    try {
      await act(async () => { paint(0); });
      expect(chars()).toEqual(['米']);
      now = 5_016;
      await act(async () => { paint(0); });
      expect(chars()).toEqual(['米']);
      now = 5_070;
      await act(async () => { paint(70); });
      expect(chars()).toEqual(['米', '多']);
      now = 5_160;
      await act(async () => { paint(70); });
      expect(chars()).toEqual(['多']);
    } finally {
      await act(async () => { root.unmount(); });
    }
  });
});
