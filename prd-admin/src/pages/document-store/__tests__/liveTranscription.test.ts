import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LiveTranscriptionSocket,
  StreamingPcm16Resampler,
  PcmFrameAccumulator,
  LivePcmFrameGate,
  bufferPendingLivePcm,
  encodeLivePcmFrame,
  floatToPcm16,
  reduceLiveTranscriptionView,
} from '../liveTranscription';

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static latest: MockWebSocket | null = null;

  readyState = MockWebSocket.CONNECTING;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  private readonly openListeners: Array<() => void> = [];
  readonly sent: unknown[] = [];
  closeCalls = 0;

  constructor(_url: string, _protocols: string[]) {
    MockWebSocket.latest = this;
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === 'open') this.openListeners.push(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type !== 'open') return;
    const index = this.openListeners.indexOf(listener);
    if (index >= 0) this.openListeners.splice(index, 1);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls++;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  failWhileConnecting(): void {
    this.onerror?.();
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
    for (const listener of this.openListeners.splice(0)) listener();
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  MockWebSocket.latest = null;
});

describe('实时转写 PCM 协议', () => {
  it('会话建立超时后整路降级，不保留有缺口的 PCM 前缀', () => {
    const pending = Array.from({ length: 100 }, () => new Int16Array(1_600).fill(1));

    const complete = bufferPendingLivePcm(pending, new Int16Array(1_600).fill(2));

    expect(complete).toBe(false);
    expect(pending).toHaveLength(0);
  });

  it('48kHz 一百毫秒音频稳定降采样为 16kHz 一千六百点', () => {
    const input = Float32Array.from({ length: 4_800 }, (_, index) =>
      Math.sin(index / 20) * 0.5);
    const resampler = new StreamingPcm16Resampler(48_000);

    const output = resampler.process(input);

    expect(output.length).toBe(1_600);
    expect(output.some(sample => sample !== 0)).toBe(true);
  });

  it('连续小块与单个大块的输出总长度一致，避免长录音逐块漂移', () => {
    const chunks = Array.from({ length: 100 }, () => new Float32Array(480).fill(0.25));
    const chunked = new StreamingPcm16Resampler(48_000);
    const chunkedLength = chunks.reduce((total, chunk) => total + chunked.process(chunk).length, 0);
    const whole = new StreamingPcm16Resampler(48_000).process(new Float32Array(48_000).fill(0.25));

    expect(chunkedLength).toBe(whole.length);
    expect(whole.length).toBe(16_000);
  });

  it('44.1kHz 非整数降采样的分块结果与整段结果逐点一致', () => {
    const input = Float32Array.from({ length: 44_100 }, (_, index) =>
      Math.sin(index / 17) * 0.6 + Math.cos(index / 43) * 0.2);
    const chunkSizes = [127, 128, 511, 97, 1_024, 333];
    const chunkedResampler = new StreamingPcm16Resampler(44_100);
    const chunks: Int16Array[] = [];
    let offset = 0;
    let chunkIndex = 0;
    while (offset < input.length) {
      const size = Math.min(chunkSizes[chunkIndex % chunkSizes.length], input.length - offset);
      chunks.push(chunkedResampler.process(input.subarray(offset, offset + size)));
      offset += size;
      chunkIndex++;
    }
    const chunkedLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const chunked = new Int16Array(chunkedLength);
    offset = 0;
    for (const chunk of chunks) {
      chunked.set(chunk, offset);
      offset += chunk.length;
    }
    const whole = new StreamingPcm16Resampler(44_100).process(input);

    expect(chunked).toEqual(whole);
    expect(whole.length).toBe(16_000);
  });

  it('任意 AudioWorklet 小块都聚合为固定一百毫秒帧，停止时保留尾帧', () => {
    const accumulator = new PcmFrameAccumulator(1_600);
    const frames = [
      ...accumulator.push(new Int16Array(700).fill(1)),
      ...accumulator.push(new Int16Array(1_000).fill(2)),
      ...accumulator.push(new Int16Array(1_500).fill(3)),
    ];
    const tail = accumulator.flush();

    expect(frames.map(frame => frame.length)).toEqual([1_600, 1_600]);
    expect(tail).toBeNull();

    accumulator.push(new Int16Array(321).fill(4));
    expect(accumulator.flush()?.length).toBe(321);
  });

  it('暂停边界先冲刷尾帧，丢弃暂停采样，并从干净相位恢复', () => {
    const frames: Int16Array[] = [];
    const gate = new LivePcmFrameGate(16_000, (pcm) => frames.push(pcm));

    gate.push(new Float32Array(500).fill(0.25));
    gate.pause();
    gate.push(new Float32Array(1_600).fill(0.5));
    gate.resume();
    gate.push(new Float32Array(1_600).fill(0.75));
    gate.stop();
    gate.stop();
    gate.resume();
    gate.push(new Float32Array(1_600).fill(1));

    expect(frames.map(frame => frame.length)).toEqual([500, 1_600]);
    expect(frames[0][0]).toBe(floatToPcm16(0.25));
    expect(frames[1][0]).toBe(floatToPcm16(0.75));
    expect(frames.every(frame => !frame.includes(floatToPcm16(0.5)))).toBe(true);
  });

  it('帧头使用四字节小端顺序号，PCM16 紧随其后', () => {
    const encoded = encodeLivePcmFrame(258, Int16Array.from([0x1234, -2]));
    const view = new DataView(encoded);

    expect(view.getInt32(0, true)).toBe(258);
    expect(view.getInt16(4, true)).toBe(0x1234);
    expect(view.getInt16(6, true)).toBe(-2);
  });

  it('浮点振幅做饱和转换，不发生整数回绕', () => {
    expect(floatToPcm16(2)).toBe(32767);
    expect(floatToPcm16(-2)).toBe(-32768);
  });
});

describe('实时转写展示状态', () => {
  it('partial 更新文字，final 固化文字', () => {
    const partial = reduceLiveTranscriptionView('', { type: 'partial', text: '第一句' });
    const completed = reduceLiveTranscriptionView(partial.text, { type: 'final', text: '第一句完成' });

    expect(partial).toMatchObject({ text: '第一句', state: 'live' });
    expect(completed).toMatchObject({ text: '第一句完成', state: 'completed' });
  });

  it('降级保留已有局部文字并明确进入批处理校准', () => {
    const degraded = reduceLiveTranscriptionView('已识别部分', {
      type: 'degraded',
      message: '结束后自动校准',
    });

    expect(degraded).toEqual({
      text: '已识别部分',
      state: 'degraded',
      message: '结束后自动校准',
    });
  });
});

describe('实时转写终态竞态', () => {
  const createSocket = () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      location: { origin: 'https://map.example.test' },
      setTimeout,
      clearTimeout,
    });
    vi.stubGlobal('WebSocket', MockWebSocket);
    const states: string[] = [];
    const socket = new LiveTranscriptionSocket(
      'session-1',
      'token-1',
      () => undefined,
      state => states.push(state),
    );
    socket.connect();
    return { socket, states, webSocket: MockWebSocket.latest! };
  };

  it('等待建连期间收到错误终态时立即结束，不再空等收尾超时', async () => {
    const { socket, webSocket } = createSocket();
    let settled = false;
    const finish = socket.finish().then(event => {
      settled = true;
      return event;
    });

    webSocket.failWhileConnecting();
    await vi.advanceTimersByTimeAsync(1);

    expect(settled).toBe(true);
    await expect(finish).resolves.toMatchObject({
      type: 'degraded',
      message: '实时转写连接异常，录音结束后将自动转写',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('连接持续未建立时二点五秒即降级，不再继续等待九十秒', async () => {
    const { socket, states } = createSocket();
    let result: Awaited<ReturnType<LiveTranscriptionSocket['finish']>> | undefined;
    const finish = socket.finish().then(event => {
      result = event;
      return event;
    });

    await vi.advanceTimersByTimeAsync(2499);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    await expect(finish).resolves.toMatchObject({ type: 'degraded' });
    expect(states.at(-1)).toBe('degraded');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('提前降级后完成录音仍发送 finish 并关闭套接字', async () => {
    const { socket, webSocket } = createSocket();
    webSocket.open();
    webSocket.onmessage?.({
      data: JSON.stringify({
        type: 'degraded',
        message: '模型池暂不可用',
      }),
    });

    await expect(socket.finish()).resolves.toMatchObject({ type: 'degraded' });

    expect(webSocket.sent).toContain(JSON.stringify({ type: 'finish', lastSequence: 0 }));
    expect(webSocket.closeCalls).toBe(1);
    expect(webSocket.readyState).toBe(MockWebSocket.CLOSED);
  });
});
