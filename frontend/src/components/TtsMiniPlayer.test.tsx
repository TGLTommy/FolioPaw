import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TtsMiniPlayer from './TtsMiniPlayer';
import { useTtsPlayerStore } from '../stores/useTtsPlayerStore';
import { ttsApi } from '../services/api';
import { FakeAudio, installFakeAudio } from '../test/fake-audio';

vi.mock('../services/api', () => ({
  ttsApi: {
    speak: vi.fn(),
  },
}));

const speakMock = vi.mocked(ttsApi.speak);

beforeEach(() => {
  installFakeAudio();
  speakMock.mockResolvedValue({ data: new Blob(['mp3']) } as never);
});

afterEach(() => {
  cleanup();
  act(() => useTtsPlayerStore.getState().stop());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('TtsMiniPlayer', () => {
  it('renders nothing while idle', () => {
    const { container } = render(<TtsMiniPlayer />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the playing label with pause and stop controls', async () => {
    render(<TtsMiniPlayer />);

    await act(() => useTtsPlayerStore.getState().play('book', '正文', '全书摘要'));

    expect(screen.getByText('全书摘要')).toBeTruthy();
    expect(screen.getByText('播放中')).toBeTruthy();
    expect(screen.getByRole('button', { name: '暂停朗读' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '停止朗读' })).toBeTruthy();
  });

  it('pauses via the pause control and disappears after stop', async () => {
    render(<TtsMiniPlayer />);
    await act(() => useTtsPlayerStore.getState().play('book', '正文', '全书摘要'));

    fireEvent.click(screen.getByRole('button', { name: '暂停朗读' }));
    expect(FakeAudio.instances[0].pause).toHaveBeenCalled();
    expect(screen.getByText('已暂停')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '停止朗读' }));
    expect(screen.queryByText('全书摘要')).toBeNull();
  });
});
