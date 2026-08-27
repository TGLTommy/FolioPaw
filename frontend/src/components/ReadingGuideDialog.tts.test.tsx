import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReadingGuideDialog from './ReadingGuideDialog';
import { readingGuideApi, ttsApi } from '../services/api';
import type { Book, ReadingGuide } from '../types';
import { FakeAudio, installFakeAudio } from '../test/fake-audio';

vi.mock('../services/api', () => ({
  readingGuideApi: {
    get: vi.fn(),
    generate: vi.fn(),
    cancel: vi.fn(),
  },
  ttsApi: {
    speak: vi.fn(),
  },
}));

const guideText = '一句话总览\n\n本书系统论述图工程范式。';

const completedGuide: ReadingGuide = {
  id: 1,
  book_id: 7,
  guide_text: guideText,
  status: 'completed',
  error_message: null,
  model_used: null,
  created_at: '2026-08-27T00:00:00Z',
  updated_at: '2026-08-27T00:00:00Z',
};

const book: Book = {
  id: 7,
  filename: 'paper.pdf',
  original_name: '2608.21156v1.pdf',
  file_url: '/uploads/paper.pdf',
  file_type: 'pdf',
  file_size: 1024,
  total_pages: 63,
  upload_time: '2026-08-25T00:00:00Z',
  last_read_page: 1,
  translation_status: 'pending',
  text_extraction_status: 'completed',
  text_page_count: 63,
  folder_id: null,
};

const speakMock = vi.mocked(ttsApi.speak);

function renderDialog(isOpen = true) {
  return render(
    <ReadingGuideDialog
      book={book}
      isOpen={isOpen}
      onClose={vi.fn()}
      onStartTranslation={vi.fn()}
      onDelete={vi.fn()}
    />
  );
}

beforeEach(() => {
  installFakeAudio();
  vi.mocked(readingGuideApi.get).mockResolvedValue({
    data: { success: true, data: completedGuide },
  } as never);
  speakMock.mockResolvedValue({ data: new Blob(['mp3']) } as never);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ReadingGuideDialog 朗读集成', () => {
  it('shows a speak button for a completed guide and synthesizes its text', async () => {
    renderDialog();
    const speakButton = await screen.findByRole('button', { name: '朗读AI摘要' });

    fireEvent.click(speakButton);

    expect(speakMock).toHaveBeenCalledWith(guideText);
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    expect(FakeAudio.instances[0].play).toHaveBeenCalled();
  });

  it('clicking again while playing pauses the audio', async () => {
    renderDialog();
    const speakButton = await screen.findByRole('button', { name: '朗读AI摘要' });

    fireEvent.click(speakButton);
    const pauseButton = await screen.findByRole('button', { name: '暂停朗读' });
    fireEvent.click(pauseButton);

    expect(FakeAudio.instances[0].pause).toHaveBeenCalled();
  });

  it('stops playback when the dialog closes', async () => {
    const { rerender } = renderDialog();
    const speakButton = await screen.findByRole('button', { name: '朗读AI摘要' });

    fireEvent.click(speakButton);
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(1));

    rerender(
      <ReadingGuideDialog
        book={book}
        isOpen={false}
        onClose={vi.fn()}
        onStartTranslation={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    expect(FakeAudio.instances[0].pause).toHaveBeenCalled();
  });
});
