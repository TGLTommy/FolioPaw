import { vi } from 'vitest';

type Listener = () => void;

/** jsdom 不支持音频播放，用可断言的假 Audio 替代 */
export class FakeAudio {
  static instances: FakeAudio[] = [];
  src: string;
  paused = true;
  playbackRate = 1;
  private listeners = new Map<string, Listener[]>();
  play = vi.fn(() => {
    this.paused = false;
    return Promise.resolve();
  });
  pause = vi.fn(() => {
    this.paused = true;
  });

  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }

  addEventListener(event: string, listener: Listener) {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  removeEventListener(event: string, listener: Listener) {
    const list = this.listeners.get(event) ?? [];
    this.listeners.set(event, list.filter(l => l !== listener));
  }

  emit(event: string) {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }

  static reset() {
    FakeAudio.instances = [];
  }
}

/** 安装 Audio / URL.createObjectURL / URL.revokeObjectURL 的测试替身 */
export function installFakeAudio() {
  FakeAudio.reset();
  vi.stubGlobal('Audio', FakeAudio);
  const createObjectURL = vi.fn(() => 'blob:mock-audio');
  const revokeObjectURL = vi.fn();
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
  return { createObjectURL, revokeObjectURL };
}
