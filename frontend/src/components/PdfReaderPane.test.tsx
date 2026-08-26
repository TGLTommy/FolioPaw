import { useEffect, type ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PdfReaderPane from './PdfReaderPane';

vi.mock('react-pdf', () => ({
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } },
  Document: ({ children, onLoadSuccess }: {
    children: ReactNode;
    onLoadSuccess: (result: { numPages: number }) => void;
  }) => {
    useEffect(() => onLoadSuccess({ numPages: 3 }), [onLoadSuccess]);
    return <div data-testid="pdf-document">{children}</div>;
  },
  Page: ({ pageNumber, width }: { pageNumber: number; width?: number }) => (
    <div data-testid="pdf-page" data-page-number={pageNumber} data-width={width ?? ''} />
  ),
}));

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

describe('PdfReaderPane', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the physical page at container width and clamps zoom to 50%–200%', async () => {
    const { rerender } = render(
      <PdfReaderPane fileUrl="/uploads/sample.pdf" pageNumber={2} />,
    );

    const page = await screen.findByTestId('pdf-page');
    await waitFor(() => expect(page).toHaveAttribute('data-width', '608'));
    expect(page).toHaveAttribute('data-page-number', '2');
    expect(screen.getByText('100%')).toBeInTheDocument();

    for (let index = 0; index < 15; index++) {
      fireEvent.click(screen.getByRole('button', { name: '放大 PDF' }));
    }
    expect(screen.getByText('200%')).toBeInTheDocument();
    expect(page).toHaveAttribute('data-width', '1216');

    for (let index = 0; index < 20; index++) {
      fireEvent.click(screen.getByRole('button', { name: '缩小 PDF' }));
    }
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(page).toHaveAttribute('data-width', '304');

    rerender(<PdfReaderPane fileUrl="/uploads/replaced.pdf" pageNumber={3} />);
    await waitFor(() => expect(screen.getByText('100%')).toBeInTheDocument());
    expect(page).toHaveAttribute('data-page-number', '3');
    expect(page).toHaveAttribute('data-width', '608');
  });
});
