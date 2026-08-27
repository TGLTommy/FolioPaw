import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SummaryPanel from './SummaryPanel';
import { summaryApi, ttsApi } from '../services/api';
import { FakeAudio, installFakeAudio } from '../test/fake-audio';

vi.mock('../services/api', () => ({
  summaryApi: {
    getSummaries: vi.fn(),
    deleteSummaries: vi.fn(),
    generateChapterSummary: vi.fn(),
    generateBookSummary: vi.fn(),
    generateAllStream: vi.fn(),
  },
  ttsApi: {
    speak: vi.fn(),
  },
}));

const getSummariesMock = vi.mocked(summaryApi.getSummaries);
const speakMock = vi.mocked(ttsApi.speak);

const bookSummaryText = '## 全书概览\n\n这是一本好书。';

function mockLoadedSummaries() {
  getSummariesMock.mockResolvedValue({
    data: {
      data: {
        chapters: [
          { id: 'ch-1', title: '第一章', pageStart: 1, pageEnd: 10, isContent: true },
        ],
        summaries: [
          {
            id: 1,
            book_id: 5,
            summary_type: 'book',
            chapter_id: null,
            chapter_title: null,
            page_start: 1,
            page_end: 10,
            summary_text: bookSummaryText,
            status: 'completed',
            error_message: null,
            model_used: null,
          },
        ],
      },
    },
  } as never);
}

function renderPanel() {
  return render(
    <SummaryPanel
      isOpen
      onClose={vi.fn()}
      bookId={5}
      bookTitle="测试书"
      totalPages={10}
    />
  );
}

beforeEach(() => {
  installFakeAudio();
  mockLoadedSummaries();
  speakMock.mockResolvedValue({ data: new Blob(['mp3']) } as never);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('SummaryPanel 朗读集成', () => {
  it('clicking the book summary speak button synthesizes the summary text', async () => {
    renderPanel();
    const speakButton = await screen.findByRole('button', { name: '朗读全书摘要' });

    fireEvent.click(speakButton);

    expect(speakMock).toHaveBeenCalledWith(bookSummaryText);
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    expect(FakeAudio.instances[0].play).toHaveBeenCalled();
  });

  it('clicking again while playing pauses the audio', async () => {
    renderPanel();
    const speakButton = await screen.findByRole('button', { name: '朗读全书摘要' });

    fireEvent.click(speakButton);
    const pauseButton = await screen.findByRole('button', { name: '暂停朗读' });
    fireEvent.click(pauseButton);

    expect(FakeAudio.instances[0].pause).toHaveBeenCalled();
  });

  it('closing the reading modal stops playback', async () => {
    renderPanel();

    // 打开阅读弹窗（点击摘要正文）
    await screen.findByRole('button', { name: '朗读全书摘要' });
    fireEvent.click(screen.getByTitle('点击展开阅读'));

    // 弹窗里开始朗读
    const modalSpeakButtons = screen.getAllByRole('button', { name: '朗读全书摘要' });
    fireEvent.click(modalSpeakButtons[modalSpeakButtons.length - 1]);
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(1));

    // 关闭弹窗（弹窗的关闭按钮是第二个「关闭」）
    const closeButtons = screen.getAllByRole('button', { name: '关闭' });
    fireEvent.click(closeButtons[closeButtons.length - 1]);

    expect(FakeAudio.instances[0].pause).toHaveBeenCalled();
  });
});
