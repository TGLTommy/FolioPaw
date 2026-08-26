import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ReadingGuideDialog from './ReadingGuideDialog';
import { readingGuideApi } from '../services/api';
import type { Book } from '../types';

vi.mock('../services/api', () => ({
  readingGuideApi: {
    get: vi.fn(),
    generate: vi.fn(),
    cancel: vi.fn(),
  },
}));

const scannedBook: Book = {
  id: 7,
  filename: 'scan.pdf',
  original_name: '扫描测试书.pdf',
  file_url: '/uploads/scan.pdf',
  file_type: 'pdf',
  file_size: 1024,
  total_pages: 2,
  upload_time: '2026-08-25T00:00:00Z',
  last_read_page: 1,
  translation_status: 'pending',
  text_extraction_status: 'unavailable',
  text_page_count: 0,
  folder_id: null,
};

describe('ReadingGuideDialog PDF capability state', () => {
  afterEach(() => vi.clearAllMocks());

  it('shows scanned PDFs as read-only and does not start AI or translation work', async () => {
    const onStartTranslation = vi.fn();
    render(
      <ReadingGuideDialog
        book={scannedBook}
        isOpen
        onClose={vi.fn()}
        onStartTranslation={onStartTranslation}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByText('扫描版 PDF，仅可原版阅读')).toBeInTheDocument();
    expect(screen.getByText(/翻译、AI摘要和其他文本能力已禁用/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始中文翻译' })).toBeDisabled();
    await waitFor(() => expect(readingGuideApi.get).not.toHaveBeenCalled());
    expect(readingGuideApi.generate).not.toHaveBeenCalled();
    expect(onStartTranslation).not.toHaveBeenCalled();
  });
});
