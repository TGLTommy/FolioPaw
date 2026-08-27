import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTtsPlayerStore } from './useTtsPlayerStore';
import { ttsApi } from '../services/api';
import { FakeAudio, installFakeAudio } from '../test/fake-audio';

vi.mock('../services/api', () => ({
  ttsApi: {
    speak: vi.fn(),
  },
}));

const speakMock = vi.mocked(ttsApi.speak);
let revokeObjectURLMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  ({ revokeObjectURL: revokeObjectURLMock } = installFakeAudio());
  speakMock.mockResolvedValue({ data: new Blob(['mp3']) } as never);
});

afterEach(() => {
  act(() => useTtsPlayerStore.getState().stop());
  act(() => useTtsPlayerStore.getState().clearError());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('useTtsPlayerStore', () => {
  it('plays synthesized audio and reports the active id and label', async () => {
    const { result } = renderHook(() => useTtsPlayerStore());

    await act(() => result.current.play('book', '## 摘要正文', '全书摘要'));

    expect(speakMock).toHaveBeenCalledWith('## 摘要正文');
    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0].play).toHaveBeenCalled();
    expect(result.current.status).toBe('playing');
    expect(result.current.activeId).toBe('book');
    expect(result.current.activeLabel).toBe('全书摘要');
  });

  it('pauses and resumes the active audio', async () => {
    const { result } = renderHook(() => useTtsPlayerStore());
    await act(() => result.current.play('book', '正文'));

    act(() => result.current.pause());
    expect(FakeAudio.instances[0].pause).toHaveBeenCalled();
    expect(result.current.status).toBe('paused');

    act(() => result.current.resume());
    expect(FakeAudio.instances[0].play).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('playing');
  });

  it('stops playback and revokes the object URL', async () => {
    const { result } = renderHook(() => useTtsPlayerStore());
    await act(() => result.current.play('book', '正文'));

    act(() => result.current.stop());

    expect(FakeAudio.instances[0].pause).toHaveBeenCalled();
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:mock-audio');
    expect(result.current.status).toBe('idle');
    expect(result.current.activeId).toBeNull();
    expect(result.current.activeLabel).toBeNull();
  });

  it('returns to idle when the audio finishes on its own', async () => {
    const { result } = renderHook(() => useTtsPlayerStore());
    await act(() => result.current.play('book', '正文'));

    await act(async () => FakeAudio.instances[0].emit('ended'));

    expect(result.current.status).toBe('idle');
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:mock-audio');
  });

  it('plays long text in segments, prefetching the next segment while one plays', async () => {
    const longText = '第一句内容。'.repeat(150); // 900 字符 → 两段
    const { result } = renderHook(() => useTtsPlayerStore());

    await act(() => result.current.play('book', longText));

    // 首段开播即可发声，第二段在后台预取
    expect(result.current.status).toBe('playing');
    expect(FakeAudio.instances).toHaveLength(1);
    await waitFor(() => expect(speakMock).toHaveBeenCalledTimes(2));

    // 首段播完自动衔接第二段
    await act(async () => FakeAudio.instances[0].emit('ended'));
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(2));
    expect(FakeAudio.instances[1].play).toHaveBeenCalled();
    expect(result.current.status).toBe('playing');

    // 第二段播完整体结束
    await act(async () => FakeAudio.instances[1].emit('ended'));
    expect(result.current.status).toBe('idle');
  });

  it('stopping a segmented playback prevents the next segment from starting', async () => {
    const longText = '第一句内容。'.repeat(150);
    const { result } = renderHook(() => useTtsPlayerStore());
    await act(() => result.current.play('book', longText));

    await act(async () => result.current.stop());

    expect(result.current.status).toBe('idle');
    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0].pause).toHaveBeenCalled();
  });

  it('stops the previous audio when another id starts playing', async () => {
    const { result } = renderHook(() => useTtsPlayerStore());
    await act(() => result.current.play('chapter-1', '第一章'));
    await act(() => result.current.play('chapter-2', '第二章'));

    expect(FakeAudio.instances).toHaveLength(2);
    expect(FakeAudio.instances[0].pause).toHaveBeenCalled();
    expect(result.current.activeId).toBe('chapter-2');
    expect(result.current.status).toBe('playing');
  });

  it('reports an error and resets when synthesis fails', async () => {
    speakMock.mockRejectedValue(new Error('service down'));
    const { result } = renderHook(() => useTtsPlayerStore());

    await act(() => result.current.play('book', '正文'));

    expect(result.current.status).toBe('idle');
    expect(result.current.activeId).toBeNull();
    expect(result.current.error).toBeTruthy();
  });

  it('surfaces the server error message from a blob error response', async () => {
    speakMock.mockRejectedValue({
      response: {
        data: new Blob([JSON.stringify({ error: '朗读文本过长' })], { type: 'application/json' }),
      },
    });
    const { result } = renderHook(() => useTtsPlayerStore());

    await act(() => result.current.play('book', '正文'));

    expect(result.current.error).toBe('朗读文本过长');
  });

  it('keeps playing after the consuming component unmounts', async () => {
    const { result, unmount } = renderHook(() => useTtsPlayerStore());
    await act(() => result.current.play('book', '正文'));

    unmount();

    expect(FakeAudio.instances[0].pause).not.toHaveBeenCalled();
    expect(useTtsPlayerStore.getState().status).toBe('playing');
  });
});

describe('segment failure retry', () => {
  it('re-synthesizes a segment once when its audio fails to play', async () => {
    const { result } = renderHook(() => useTtsPlayerStore());
    await act(() => result.current.play('book', '正文'));
    expect(speakMock).toHaveBeenCalledTimes(1);

    await act(async () => FakeAudio.instances[0].emit('error'));

    await waitFor(() => expect(speakMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(2));
    // 重试段改用 data: URL 加载（WebKit 对 blob URL 的 MIME 处理最严格）
    expect(FakeAudio.instances[1].src.startsWith('data:audio/mpeg')).toBe(true);
    expect(FakeAudio.instances[1].play).toHaveBeenCalled();
    expect(useTtsPlayerStore.getState().status).toBe('playing');
    expect(useTtsPlayerStore.getState().error).toBeNull();
  });

  it('gives up with an error when the retried segment also fails', async () => {
    const { result } = renderHook(() => useTtsPlayerStore());
    await act(() => result.current.play('book', '正文'));

    await act(async () => FakeAudio.instances[0].emit('error'));
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(2));
    await act(async () => FakeAudio.instances[1].emit('error'));

    expect(useTtsPlayerStore.getState().status).toBe('idle');
    expect(useTtsPlayerStore.getState().error).toMatch(/^音频播放失败/);
  });
});

describe('playback rate', () => {
  it('defaults to 1x', () => {
    expect(useTtsPlayerStore.getState().playbackRate).toBe(1);
  });

  it('applies the new rate to the currently playing audio', async () => {
    const { result } = renderHook(() => useTtsPlayerStore());
    await act(() => result.current.play('book', '正文'));

    act(() => result.current.setPlaybackRate(1.5));

    expect(result.current.playbackRate).toBe(1.5);
    expect(FakeAudio.instances[0].playbackRate).toBe(1.5);
  });

  it('carries the rate over to subsequent segments', async () => {
    const longText = '第一句内容。'.repeat(150); // 两段
    const { result } = renderHook(() => useTtsPlayerStore());
    await act(() => result.current.play('book', longText));

    act(() => result.current.setPlaybackRate(2));
    await act(async () => FakeAudio.instances[0].emit('ended'));
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(2));

    expect(FakeAudio.instances[1].playbackRate).toBe(2);
  });

  it('persists the chosen rate to localStorage', () => {
    const { result } = renderHook(() => useTtsPlayerStore());
    act(() => result.current.setPlaybackRate(1.25));

    expect(localStorage.getItem('foliopaw.tts.playbackRate')).toBe('1.25');
    act(() => result.current.setPlaybackRate(1));
  });
});
