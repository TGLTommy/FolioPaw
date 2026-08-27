import { create } from 'zustand';
import { ttsApi } from '../services/api';
import { getErrorMessage } from '../utils/error';
import { splitTextForTts } from '../utils/ttsSegments';

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

// 音频元素放在模块级：合成与播放不随任何组件卸载而中断，直到播完或用户手动停止。
// 长文本按句子分段合成：首段几秒内开播，播放时预取下一段，避免整段合成的漫长等待与超时。
let audioEl: HTMLAudioElement | null = null;
let objectUrl: string | null = null;
let requestSeq = 0;
// stop/切换时提前结束当前段的等待，让播放队列协程能立即退出
let finishCurrentSegment: (() => void) | null = null;

function releaseAudio() {
  if (audioEl) {
    audioEl.pause();
    audioEl = null;
  }
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  if (finishCurrentSegment) {
    const finish = finishCurrentSegment;
    finishCurrentSegment = null;
    finish();
  }
}

async function fetchSegmentUrl(segment: string): Promise<string> {
  const res = await ttsApi.speak(segment);
  return URL.createObjectURL(res.data);
}

type SetState = (partial: Partial<TtsPlayerState>) => void;

/** 播放一段音频；在播完、出错或被 stop 释放时结束 */
function playSegmentAudio(url: string, seq: number, set: SetState): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = new Audio(url);
    objectUrl = url;
    audioEl = audio;
    finishCurrentSegment = resolve;

    audio.addEventListener('ended', () => {
      finishCurrentSegment = null;
      resolve();
    });
    audio.addEventListener('error', () => {
      finishCurrentSegment = null;
      reject(new Error(AUDIO_PLAYBACK_ERROR));
    });

    audio
      .play()
      .then(() => {
        if (seq === requestSeq) set({ status: 'playing' });
      })
      .catch((err) => {
        finishCurrentSegment = null;
        reject(err);
      });
  });
}

const AUDIO_PLAYBACK_ERROR = '音频播放失败';

/** 逐段播放队列：播放第 i 段的同时预取第 i+1 段；段音频损坏时重新合成该段一次 */
async function runQueue(seq: number, segments: string[], firstUrl: string, set: SetState) {
  let url: string | null = firstUrl;
  try {
    for (let i = 0; i < segments.length; i++) {
      if (seq !== requestSeq) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      const nextUrlPromise = i + 1 < segments.length ? fetchSegmentUrl(segments[i + 1]) : null;
      try {
        await playSegmentAudio(url!, seq, set);
      } catch (err: unknown) {
        if (seq !== requestSeq) return;
        if (!(err instanceof Error) || err.message !== AUDIO_PLAYBACK_ERROR) throw err;
        // 偶发的损坏音频（如上游中断产生的半截数据）：重新合成该段一次
        releaseAudio();
        const retryUrl = await fetchSegmentUrl(segments[i]);
        if (seq !== requestSeq) {
          URL.revokeObjectURL(retryUrl);
          return;
        }
        await playSegmentAudio(retryUrl, seq, set);
      }
      // 当前段正常播完：释放其资源（被 stop 释放时 releaseAudio 已处理）
      if (seq === requestSeq) {
        audioEl = null;
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = null;
        }
      }
      url = nextUrlPromise ? await nextUrlPromise : null;
    }
    if (seq !== requestSeq) return;
    set({ status: 'idle', activeId: null, activeLabel: null });
  } catch (err: unknown) {
    const message = await extractErrorMessage(err);
    if (seq !== requestSeq) return;
    releaseAudio();
    set({ status: 'idle', activeId: null, activeLabel: null, error: message });
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

    // 空白文本保持整段直传，让后端返回统一的中文校验报错
    const segments = splitTextForTts(text);
    const queue = segments.length > 0 ? segments : [text];

    try {
      const firstUrl = await fetchSegmentUrl(queue[0]);
      // 请求返回前用户已切换/停止，丢弃过期音频
      if (seq !== requestSeq) {
        URL.revokeObjectURL(firstUrl);
        return;
      }
      void runQueue(seq, queue, firstUrl, set);
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
