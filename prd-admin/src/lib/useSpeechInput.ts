/**
 * 浏览器原生语音输入 hook（Web Speech API）。
 *
 * 能力检测优先：Chrome / Edge 走 webkitSpeechRecognition，不支持的浏览器 supported=false，
 * 调用方应直接隐藏入口（无根之木禁令：不假装能做）。
 * continuous + interimResults：边说边出字，最终文本与临时文本分开回调，由调用方拼接。
 */
import { useEffect, useMemo, useRef, useState } from 'react';

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export function useSpeechInput({
  lang = 'zh-CN',
  onResult,
  onError,
}: {
  lang?: string;
  /** finalText：本次聆听累计的最终文本；interimText：当前临时识别文本 */
  onResult: (finalText: string, interimText: string) => void;
  /** 已过滤 no-speech / aborted 等非错误场景 */
  onError?: (message: string) => void;
}) {
  const [listening, setListening] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const onResultRef = useRef(onResult);
  const onErrorRef = useRef(onError);
  onResultRef.current = onResult;
  onErrorRef.current = onError;

  const supported = useMemo(() => getCtor() != null, []);

  const stop = () => {
    recRef.current?.stop();
    setListening(false);
  };

  const start = () => {
    const Ctor = getCtor();
    if (!Ctor || recRef.current) return;
    const rec = new Ctor();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    let finalText = '';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      onResultRef.current(finalText, interim);
    };
    rec.onend = () => {
      recRef.current = null;
      setListening(false);
    };
    rec.onerror = (e) => {
      const err = e.error ?? '';
      if (err && err !== 'no-speech' && err !== 'aborted') {
        const msg = err === 'not-allowed' || err === 'service-not-allowed'
          ? '麦克风权限被拒绝，请在浏览器地址栏允许麦克风'
          : err === 'audio-capture'
            ? '没有检测到麦克风设备'
            : `语音识别出错：${err}`;
        onErrorRef.current?.(msg);
      }
      recRef.current = null;
      setListening(false);
    };
    recRef.current = rec;
    rec.start();
    setListening(true);
  };

  // 卸载时静默中止，不触发回调
  useEffect(() => () => {
    const rec = recRef.current;
    if (rec) {
      rec.onresult = null;
      rec.onend = null;
      rec.onerror = null;
      rec.abort();
      recRef.current = null;
    }
  }, []);

  return { supported, listening, start, stop, toggle: () => (listening ? stop() : start()) };
}
