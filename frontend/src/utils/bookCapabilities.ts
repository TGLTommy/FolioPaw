import type { Book } from '../types';

export type ReadingMode = 'translated' | 'original';

export function canUseBookTextFeatures(
  book: Pick<Book, 'text_extraction_status' | 'import_status'> | null | undefined
): boolean {
  return (!book?.import_status || book.import_status === 'ready')
    && book?.text_extraction_status !== 'unavailable';
}

export function getDefaultReadingMode(): ReadingMode {
  return 'original';
}
