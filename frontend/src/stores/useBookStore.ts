import { create } from 'zustand';
import type { Book, Page } from '../types/index';

interface BookState {
  currentBook: Book | null;
  currentPage: number;
  pages: Record<number, Page>;
  isLoading: boolean;
  error: string | null;

  setCurrentBook: (book: Book | null) => void;
  setCurrentPage: (page: number) => void;
  setPage: (page: Page) => void;
  setPages: (pages: Page[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  nextPage: () => void;
  previousPage: () => void;
}

export const useBookStore = create<BookState>((set) => ({
  currentBook: null,
  currentPage: 1,
  pages: {},
  isLoading: false,
  error: null,

  setCurrentBook: (book) => set({
    currentBook: book,
    currentPage: book?.last_read_page || 1,
  }),

  setCurrentPage: (page) =>
    set((state) => ({
      currentPage: page,
      currentBook: state.currentBook
        ? { ...state.currentBook, last_read_page: page }
        : state.currentBook,
    })),

  setPage: (page) =>
    set((state) => ({
      pages: { ...state.pages, [page.page_number]: page },
    })),

  setPages: (pages) =>
    set({
      pages: pages.reduce((acc, page) => {
        acc[page.page_number] = page;
        return acc;
      }, {} as Record<number, Page>),
    }),

  setLoading: (loading) => set({ isLoading: loading }),

  setError: (error) => set({ error }),

  nextPage: () =>
    set((state) => {
      const maxPage = state.currentBook?.total_pages || 1;
      const nextPage = Math.min(state.currentPage + 1, maxPage);
      return {
        currentPage: nextPage,
        currentBook: state.currentBook
          ? { ...state.currentBook, last_read_page: nextPage }
          : state.currentBook,
      };
    }),

  previousPage: () =>
    set((state) => {
      const previousPage = Math.max(state.currentPage - 1, 1);
      return {
        currentPage: previousPage,
        currentBook: state.currentBook
          ? { ...state.currentBook, last_read_page: previousPage }
          : state.currentBook,
      };
    }),
}));
