export type LiveTranscriptionEvent = {
  type: 'ready' | 'status' | 'partial' | 'final' | 'degraded' | 'error';
  sequence?: number;
  text?: string;
  stable?: boolean;
  message?: string;
  provider?: string;
  model?: string;
  attempt?: number;
  totalAttempts?: number;
  errorCode?: string;
};

export type LiveTranscriptionState = 'connecting' | 'live' | 'finalizing' | 'completed' | 'degraded';

export function reduceLiveTranscriptionView(
  currentText: string,
  event: LiveTranscriptionEvent,
): { text: string; state: LiveTranscriptionState; message: string } {
  const text = event.text?.trim() || currentText;
  switch (event.type) {
    case 'final':
      return { text, state: 'completed', message: event.message || '实时转写已完成' };
    case 'degraded':
    case 'error':
      return { text, state: 'degraded', message: event.message || '实时转写已降级，结束后将自动校准' };
    case 'ready':
    case 'partial':
      return { text, state: 'live', message: event.message || '正在实时转写' };
    default:
      return { text, state: 'connecting', message: event.message || '正在连接实时转写' };
  }
}

const TARGET_SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 1_600;
const MAX_QUEUED_FRAMES = 300;
export const MAX_PENDING_LIVE_PCM_FRAMES = 100;

/**
 * 会话创建前的 PCM 只允许短时缓冲。达到上限后返回 false 并清空已有帧，
 * 调用方必须停用本次实时转写，让完整录音在结束后统一校准；禁止跳过中段后
 * 继续生成连续序号，否则服务端无法识别音频缺口。
 */
export function bufferPendingLivePcm(
  pending: Int16Array[],
  pcm: Int16Array,
  capacity = MAX_PENDING_LIVE_PCM_FRAMES,
): boolean {
  if (pending.length >= capacity) {
    pending.length = 0;
    return false;
  }
  pending.push(pcm);
  return true;
}

export class StreamingPcm16Resampler {
  private nextSourcePosition = 0;
  private inputSamplesSeen = 0;
  private previousSample: number | null = null;

  constructor(
    private readonly inputSampleRate: number,
    private readonly outputSampleRate = TARGET_SAMPLE_RATE,
  ) {
    if (inputSampleRate <= 0 || outputSampleRate <= 0)
      throw new Error('采样率必须大于 0');
  }

  process(input: Float32Array): Int16Array {
    if (input.length === 0) return new Int16Array();
    const ratio = this.inputSampleRate / this.outputSampleRate;
    const blockStart = this.inputSamplesSeen;
    const blockEnd = blockStart + input.length;
    const lastAvailablePosition = blockEnd - 1;
    const samples: number[] = [];
    while (this.nextSourcePosition <= lastAvailablePosition) {
      const left = Math.floor(this.nextSourcePosition);
      const fraction = this.nextSourcePosition - left;
      // 非整数位置若落在块尾与下一块首样本之间，必须等下一次 process 再插值。
      // previousSample 保留上一块末样本，使分块输入与整段输入得到完全相同的 PCM。
      if (fraction > 0 && left + 1 >= blockEnd) break;
      const readSample = (position: number): number => {
        if (position === blockStart - 1 && this.previousSample != null)
          return this.previousSample;
        return input[position - blockStart];
      };
      const leftSample = readSample(left);
      const rightSample = fraction === 0 ? leftSample : readSample(left + 1);
      const sample = leftSample + (rightSample - leftSample) * fraction;
      samples.push(floatToPcm16(sample));
      this.nextSourcePosition += ratio;
    }
    this.previousSample = input[input.length - 1];
    this.inputSamplesSeen = blockEnd;
    return Int16Array.from(samples);
  }
}

export function floatToPcm16(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value));
  return clamped < 0
    ? Math.round(clamped * 0x8000)
    : Math.round(clamped * 0x7fff);
}

export class PcmFrameAccumulator {
  private readonly pending: Int16Array;
  private pendingLength = 0;

  constructor(private readonly frameSamples = FRAME_SAMPLES) {
    if (!Number.isInteger(frameSamples) || frameSamples <= 0)
      throw new Error('PCM 分帧长度必须为正整数');
    this.pending = new Int16Array(frameSamples);
  }

  push(input: Int16Array): Int16Array[] {
    const frames: Int16Array[] = [];
    let offset = 0;
    while (offset < input.length) {
      const count = Math.min(this.frameSamples - this.pendingLength, input.length - offset);
      this.pending.set(input.subarray(offset, offset + count), this.pendingLength);
      this.pendingLength += count;
      offset += count;
      if (this.pendingLength === this.frameSamples) {
        frames.push(this.pending.slice());
        this.pendingLength = 0;
      }
    }
    return frames;
  }

  flush(): Int16Array | null {
    if (this.pendingLength === 0) return null;
    const tail = this.pending.slice(0, this.pendingLength);
    this.pendingLength = 0;
    return tail;
  }
}

export function encodeLivePcmFrame(sequence: number, pcm: Int16Array): ArrayBuffer {
  if (!Number.isInteger(sequence) || sequence <= 0)
    throw new Error('实时音频顺序号必须为正整数');
  const frame = new ArrayBuffer(4 + pcm.byteLength);
  const view = new DataView(frame);
  view.setInt32(0, sequence, true);
  new Int16Array(frame, 4).set(pcm);
  return frame;
}

function apiWebSocketUrl(sessionId: string): string {
  const configured = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '')
    .trim()
    .replace(/\/+$/, '');
  const relativePath = `/api/document-store/recording-uploads/${encodeURIComponent(sessionId)}/live-transcription`;
  const httpUrl = configured
    ? new URL(
        `${configured}${configured.endsWith('/api') ? relativePath.slice(4) : relativePath}`,
        window.location.origin,
      )
    : new URL(relativePath, window.location.origin);
  httpUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  return httpUrl.toString();
}

export class LiveTranscriptionSocket {
  private socket: WebSocket | null = null;
  private sequence = 0;
  private queuedFrames: ArrayBuffer[] = [];
  private terminalEvent: LiveTranscriptionEvent | null = null;
  private terminalWaiters: Array<(event: LiveTranscriptionEvent | null) => void> = [];
  private state: LiveTranscriptionState = 'connecting';

  constructor(
    private readonly sessionId: string,
    private readonly token: string,
    private readonly onEvent: (event: LiveTranscriptionEvent) => void,
    private readonly onState: (state: LiveTranscriptionState) => void,
  ) {}

  connect(): void {
    if (this.socket) return;
    this.setState('connecting');
    const socket = new WebSocket(
      apiWebSocketUrl(this.sessionId),
      ['map-live-asr', `bearer.${this.token}`],
    );
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.onopen = () => {
      this.setState('live');
      for (const frame of this.queuedFrames) socket.send(frame);
      this.queuedFrames = [];
    };
    socket.onmessage = (message) => {
      if (typeof message.data !== 'string') return;
      try {
        const event = JSON.parse(message.data) as LiveTranscriptionEvent;
        if (!event?.type) return;
        if (event.type === 'ready' || event.type === 'partial') this.setState('live');
        if (event.type === 'final') this.setState('completed');
        if (event.type === 'degraded' || event.type === 'error') this.setState('degraded');
        this.onEvent(event);
        if (event.type === 'final' || event.type === 'degraded' || event.type === 'error')
          this.resolveTerminal(event);
      } catch {
        // 无效消息不应打断录音与本地保险箱。
      }
    };
    socket.onerror = () => {
      this.setState('degraded');
      this.resolveTerminal({
        type: 'degraded',
        message: '实时转写连接异常，录音结束后将自动转写',
      });
    };
    socket.onclose = () => {
      if (!this.terminalEvent) {
        this.setState('degraded');
        this.resolveTerminal({
          type: 'degraded',
          message: '实时转写连接已断开，录音结束后将自动转写',
        });
      }
    };
  }

  send(pcm: Int16Array): void {
    if (pcm.length === 0 || this.terminalEvent) return;
    const frame = encodeLivePcmFrame(++this.sequence, pcm);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(frame);
      return;
    }
    if (this.queuedFrames.length >= MAX_QUEUED_FRAMES) {
      this.setState('degraded');
      this.resolveTerminal({
        type: 'degraded',
        message: '网络过慢，实时转写已降级，录音仍在安全保存',
      });
      this.close();
      return;
    }
    this.queuedFrames.push(frame);
  }

  async finish(timeoutMs = 90_000): Promise<LiveTranscriptionEvent | null> {
    if (this.terminalEvent) {
      const terminal = this.terminalEvent;
      this.signalFinishAndClose();
      return terminal;
    }
    this.setState('finalizing');
    const socket = this.socket;
    if (!socket) return null;

    // 必须先登记终态等待，再等待 WebSocket 建连。连接错误和 close 都可能在
    // 下面的 await 期间到达；若事后才登记 waiter，一次性终态事件会永久丢失。
    const terminalPromise = this.waitForTerminal(timeoutMs);

    if (socket.readyState === WebSocket.CONNECTING) {
      await this.waitForConnection(socket, terminalPromise);
    }
    if (this.terminalEvent) {
      this.signalFinishAndClose();
      return this.terminalEvent;
    }
    if (socket.readyState !== WebSocket.OPEN) {
      this.setState('degraded');
      this.resolveTerminal({
        type: 'degraded',
        message: '实时转写连接超时，录音结束后将自动转写',
      });
      this.close();
      return this.terminalEvent;
    }
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'finish', lastSequence: this.sequence }));
    }

    const terminal = await terminalPromise;
    if (!terminal) {
      this.setState('degraded');
      this.resolveTerminal({
        type: 'degraded',
        message: '实时转写收尾超时，录音结束后将自动校准',
      });
    }
    this.close();
    return terminal ?? this.terminalEvent;
  }

  private signalFinishAndClose(): void {
    const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'finish', lastSequence: this.sequence }));
    }
    this.close();
  }

  close(): void {
    const socket = this.socket;
    if (socket && socket.readyState < WebSocket.CLOSING)
      socket.close(1000, 'recording-finished');
    this.socket = null;
    this.queuedFrames = [];
  }

  private setState(state: LiveTranscriptionState): void {
    if (this.state === state) return;
    this.state = state;
    this.onState(state);
  }

  private resolveTerminal(event: LiveTranscriptionEvent): void {
    if (this.terminalEvent) return;
    this.terminalEvent = event;
    for (const resolve of this.terminalWaiters.splice(0)) resolve(event);
  }

  private waitForTerminal(timeoutMs: number): Promise<LiveTranscriptionEvent | null> {
    if (this.terminalEvent) return Promise.resolve(this.terminalEvent);
    return new Promise((resolve) => {
      let settled = false;
      const timeout = { id: undefined as number | undefined };
      const waiter = (event: LiveTranscriptionEvent | null) => {
        if (settled) return;
        settled = true;
        if (timeout.id !== undefined) window.clearTimeout(timeout.id);
        const index = this.terminalWaiters.indexOf(waiter);
        if (index >= 0) this.terminalWaiters.splice(index, 1);
        resolve(event);
      };
      this.terminalWaiters.push(waiter);
      timeout.id = window.setTimeout(() => waiter(null), timeoutMs);
      // 保持终态为 sticky 状态，防止未来重构在登记 waiter 附近再次引入竞态。
      if (this.terminalEvent) waiter(this.terminalEvent);
    });
  }

  private async waitForConnection(
    socket: WebSocket,
    terminalPromise: Promise<LiveTranscriptionEvent | null>,
  ): Promise<void> {
    const timeout = { id: undefined as number | undefined };
    let handleOpen: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
      handleOpen = () => resolve();
      socket.addEventListener('open', handleOpen, { once: true });
    });
    const timedOut = new Promise<void>((resolve) => {
      timeout.id = window.setTimeout(resolve, 2500);
    });
    try {
      await Promise.race([opened, terminalPromise.then(() => undefined), timedOut]);
    } finally {
      if (timeout.id !== undefined) window.clearTimeout(timeout.id);
      socket.removeEventListener('open', handleOpen);
    }
  }
}

export async function startLivePcmCapture(
  context: AudioContext,
  source: MediaStreamAudioSourceNode,
  onPcm: (pcm: Int16Array) => void,
): Promise<() => void> {
  const resampler = new StreamingPcm16Resampler(context.sampleRate);
  const accumulator = new PcmFrameAccumulator();
  const acceptSamples = (samples: Int16Array) => {
    for (const frame of accumulator.push(samples)) onPcm(frame);
  };
  const flushTail = () => {
    const tail = accumulator.flush();
    if (tail) onPcm(tail);
  };
  if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
    const sourceCode = `
      class MapLivePcmProcessor extends AudioWorkletProcessor {
        process(inputs) {
          const input = inputs[0] && inputs[0][0];
          if (input && input.length) this.port.postMessage(input.slice());
          return true;
        }
      }
      registerProcessor('map-live-pcm', MapLivePcmProcessor);
    `;
    const moduleUrl = URL.createObjectURL(new Blob([sourceCode], { type: 'text/javascript' }));
    try {
      await context.audioWorklet.addModule(moduleUrl);
      const node = new AudioWorkletNode(context, 'map-live-pcm');
      const silent = context.createGain();
      silent.gain.value = 0;
      node.port.onmessage = (event: MessageEvent<Float32Array>) => acceptSamples(resampler.process(event.data));
      source.connect(node);
      node.connect(silent);
      silent.connect(context.destination);
      return () => {
        flushTail();
        node.port.onmessage = null;
        source.disconnect(node);
        node.disconnect();
        silent.disconnect();
      };
    } catch {
      // 部分 Safari 版本暴露 audioWorklet 但禁止 blob module；继续走 ScriptProcessor 兼容路径。
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
  }

  const processor = context.createScriptProcessor(4096, 1, 1);
  const silent = context.createGain();
  silent.gain.value = 0;
  processor.onaudioprocess = (event) => {
    acceptSamples(resampler.process(event.inputBuffer.getChannelData(0)));
  };
  source.connect(processor);
  processor.connect(silent);
  silent.connect(context.destination);
  return () => {
    flushTail();
    processor.onaudioprocess = null;
    source.disconnect(processor);
    processor.disconnect();
    silent.disconnect();
  };
}
