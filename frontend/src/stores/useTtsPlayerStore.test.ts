import { act, renderHook } from '@testing-library/react';
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

    act(() => FakeAudio.instances[0].emit('ended'));

    expect(result.current.status).toBe('idle');
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:mock-audio');
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
