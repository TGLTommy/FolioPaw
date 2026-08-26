import { create } from 'zustand';
import type { Folder } from '../types/index';

interface FolderState {
  folders: Folder[];
  selectedFolderId: number | null | 'all';
  uncategorizedCount: number;
  isLoading: boolean;

  setFolders: (folders: Folder[]) => void;
  setSelectedFolderId: (id: number | null | 'all') => void;
  setUncategorizedCount: (countOrFn: number | ((prev: number) => number)) => void;
  setLoading: (loading: boolean) => void;
  addFolder: (folder: Folder) => void;
  updateFolder: (id: number, updates: Partial<Folder>) => void;
  removeFolder: (id: number) => void;
  decrementFolderCount: (id: number) => void;
  incrementFolderCount: (id: number) => void;
}

export const useFolderStore = create<FolderState>((set) => ({
  folders: [],
  selectedFolderId: 'all',
  uncategorizedCount: 0,
  isLoading: false,

  setFolders: (folders) => set({ folders }),

  setSelectedFolderId: (id) => set({ selectedFolderId: id }),

  setUncategorizedCount: (countOrFn) => set((state) => ({
    uncategorizedCount: typeof countOrFn === 'function' ? countOrFn(state.uncategorizedCount) : countOrFn
  })),

  setLoading: (loading) => set({ isLoading: loading }),

  addFolder: (folder) => set((state) => ({
    folders: [...state.folders, folder],
  })),

  updateFolder: (id, updates) => set((state) => ({
    folders: state.folders.map((f) =>
      f.id === id ? { ...f, ...updates } : f
    ),
  })),

  removeFolder: (id) => set((state) => ({
    folders: state.folders.filter((f) => f.id !== id),
    selectedFolderId: state.selectedFolderId === id ? 'all' : state.selectedFolderId,
  })),

  decrementFolderCount: (id) => set((state) => ({
    folders: state.folders.map((f) =>
      f.id === id ? { ...f, book_count: Math.max(0, f.book_count - 1) } : f
    ),
  })),

  incrementFolderCount: (id) => set((state) => ({
    folders: state.folders.map((f) =>
      f.id === id ? { ...f, book_count: f.book_count + 1 } : f
    ),
  })),
}));
