import { create } from 'zustand';
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

interface TtsPlayerState {
  status: TtsStatus;
  activeId: string | null;
  /** 当前朗读内容的展示名称，用于全局迷你播放条 */
  activeLabel: string | null;
  error: string | null;
  play: (id: string, text: string, label?: string) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  clearError: () => void;
}

/** 供组件消费的播放器接口（TtsSpeakButton 等） */
export type TtsPlayer = Pick<
  TtsPlayerState,
  'status' | 'activeId' | 'error' | 'play' | 'pause' | 'resume' | 'stop' | 'clearError'
>;

// 音频元素放在模块级：合成与播放不随任何组件卸载而中断，直到播完或用户手动停止
let audioEl: HTMLAudioElement | null = null;
let objectUrl: string | null = null;
let requestSeq = 0;

function releaseAudio() {
  if (audioEl) {
    audioEl.pause();
    audioEl = null;
  }
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
}

export const useTtsPlayerStore = create<TtsPlayerState>((set) => ({
  status: 'idle',
  activeId: null,
  activeLabel: null,
  error: null,

  play: async (id, text, label) => {
    const seq = ++requestSeq;
    releaseAudio();
    set({ error: null, status: 'loading', activeId: id, activeLabel: label ?? null });

    try {
      const res = await ttsApi.speak(text);
      // 请求返回前用户已切换/停止，丢弃过期音频
      if (seq !== requestSeq) return;

      const url = URL.createObjectURL(res.data);
      const audio = new Audio(url);
      objectUrl = url;
      audioEl = audio;

      audio.addEventListener('ended', () => {
        if (seq !== requestSeq) return;
        releaseAudio();
        set({ status: 'idle', activeId: null, activeLabel: null });
      });
      audio.addEventListener('error', () => {
        if (seq !== requestSeq) return;
        releaseAudio();
        set({ status: 'idle', activeId: null, activeLabel: null, error: '音频播放失败' });
      });

      await audio.play();
      if (seq !== requestSeq) return;
      set({ status: 'playing' });
    } catch (err: unknown) {
      const message = await extractErrorMessage(err);
      if (seq !== requestSeq) return;
      releaseAudio();
      set({ status: 'idle', activeId: null, activeLabel: null, error: message });
    }
  },

  pause: () => {
    if (audioEl && !audioEl.paused) {
      audioEl.pause();
      set({ status: 'paused' });
    }
  },

  resume: () => {
    if (audioEl?.paused) {
      void audioEl.play();
      set({ status: 'playing' });
    }
  },

  stop: () => {
    requestSeq += 1;
    releaseAudio();
    set({ status: 'idle', activeId: null, activeLabel: null });
  },

  clearError: () => set({ error: null }),
}));
