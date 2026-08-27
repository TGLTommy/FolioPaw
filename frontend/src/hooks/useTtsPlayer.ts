import { useCallback, useEffect, useRef, useState } from 'react';
import { ttsApi } from '../services/api';
import { getErrorMessage } from '../utils/error';

export type TtsStatus = 'idle' | 'loading' | 'playing' | 'paused';

// responseType: 'blob' 时服务端 JSON 错误体也是 Blob，需要解析出中文报错
async function extractErrorMessage(err: unknown): Promise<string> {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  if (data instanceof Blob) {
    try {
      const parsed = JSON.parse(await data.text());
      if (typeof parsed?.error === 'string' && parsed.error) return parsed.error;
    } catch {
      // 非 JSON 错误体，回退到通用提示
    }
  }
  return getErrorMessage(err, '语音朗读失败');
}

export interface TtsPlayer {
  status: TtsStatus;
  activeId: string | null;
  error: string | null;
  play: (id: string, text: string) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  clearError: () => void;
}

/**
 * 单例语音朗读播放器：同一时间只播放一段音频，
 * 组件卸载或切换朗读目标时自动停止并释放资源。
 */
export function useTtsPlayer(): TtsPlayer {
  const [status, setStatus] = useState<TtsStatus>('idle');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const requestSeqRef = useRef(0);

  const releaseAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    requestSeqRef.current += 1;
    releaseAudio();
    setStatus('idle');
    setActiveId(null);
  }, [releaseAudio]);

  const play = useCallback(async (id: string, text: string) => {
    const seq = ++requestSeqRef.current;
    releaseAudio();
    setError(null);
    setStatus('loading');
    setActiveId(id);

    try {
      const res = await ttsApi.speak(text);
      // 请求返回前用户已切换/停止，丢弃过期音频
      if (seq !== requestSeqRef.current) return;

      const url = URL.createObjectURL(res.data);
      const audio = new Audio(url);
      objectUrlRef.current = url;
      audioRef.current = audio;

      audio.addEventListener('ended', () => {
        if (seq !== requestSeqRef.current) return;
        releaseAudio();
        setStatus('idle');
        setActiveId(null);
      });
      audio.addEventListener('error', () => {
        if (seq !== requestSeqRef.current) return;
        releaseAudio();
        setStatus('idle');
        setActiveId(null);
        setError('音频播放失败');
      });

      await audio.play();
      if (seq !== requestSeqRef.current) return;
      setStatus('playing');
    } catch (err: unknown) {
      const message = await extractErrorMessage(err);
      if (seq !== requestSeqRef.current) return;
      releaseAudio();
      setStatus('idle');
      setActiveId(null);
      setError(message);
    }
  }, [releaseAudio]);

  const pause = useCallback(() => {
    if (audioRef.current && !audioRef.current.paused) {
      audioRef.current.pause();
      setStatus('paused');
    }
  }, []);

  const resume = useCallback(() => {
    if (audioRef.current?.paused) {
      void audioRef.current.play();
      setStatus('playing');
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  // 组件卸载时停止播放并释放资源
  useEffect(() => () => {
    requestSeqRef.current += 1;
    releaseAudio();
  }, [releaseAudio]);

  return { status, activeId, error, play, pause, resume, stop, clearError };
}
