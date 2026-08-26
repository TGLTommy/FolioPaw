import { useCallback, useEffect, useState } from 'react';
import { Folder, FolderPlus, BookX, Library, MoreVertical, Pencil, Trash2, X, Check } from 'lucide-react';
import type { Folder as FolderType } from '../types/index';
import { useFolderStore } from '../stores/useFolderStore';
import { folderApi } from '../services/api';
import { useToast } from '../contexts/useToast';
import ConfirmDialog from './ConfirmDialog';
import { getApiErrorMessage } from '../utils/error';

interface Props {
  onCreateFolder: () => void;
}

export default function FolderSidebar({ onCreateFolder }: Props) {
  const {
    folders,
    selectedFolderId,
    uncategorizedCount,
    setSelectedFolderId,
    removeFolder,
    updateFolder,
  } = useFolderStore();
  const { addToast } = useToast();
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  const totalBooks = folders.reduce((sum, f) => sum + f.book_count, 0) + uncategorizedCount;

  const handleDelete = async () => {
    if (!deleteConfirmId) return;
    setIsDeleting(true);
    try {
      await folderApi.delete(deleteConfirmId);
      removeFolder(deleteConfirmId);
      addToast('文件夹已删除', 'success');
      setDeleteConfirmId(null);
    } catch (error: unknown) {
      addToast(getApiErrorMessage(error, '删除失败'), 'error');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleStartEdit = (folder: FolderType) => {
    setEditingId(folder.id);
    setEditingName(folder.name);
    setMenuOpenId(null);
  };

  const handleSaveEdit = async () => {
    if (!editingId || !editingName.trim()) return;

    try {
      const response = await folderApi.update(editingId, { name: editingName.trim() });
      updateFolder(editingId, response.data.data);
      addToast('文件夹已重命名', 'success');
      setEditingId(null);
      setEditingName('');
    } catch (error: unknown) {
      addToast(getApiErrorMessage(error, '重命名失败'), 'error');
    }
  };

  const handleCancelEdit = useCallback(() => {
    setEditingId(null);
    setEditingName('');
  }, []);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (
        target?.closest('.folder-menu') ||
        target?.closest('.folder-menu-trigger')
      ) {
        return;
      }

      setMenuOpenId(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;

      setMenuOpenId(null);
      handleCancelEdit();
      if (!isDeleting) {
        setDeleteConfirmId(null);
      }
    };

    if (menuOpenId !== null) {
      document.addEventListener('mousedown', handlePointerDown);
    }
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpenId, isDeleting, handleCancelEdit]);

  return (
    <aside className="w-56 bg-white border-r border-gray-200 h-full flex flex-col flex-shrink-0">
      <div className="p-3 border-b border-gray-200">
        <button
          onClick={onCreateFolder}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors text-sm"
        >
          <FolderPlus size={16} />
          <span>新建文件夹</span>
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto p-2">
        {/* All Books */}
        <button
          onClick={() => setSelectedFolderId('all')}
          className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors text-sm ${
            selectedFolderId === 'all'
              ? 'bg-blue-100 text-blue-600'
              : 'hover:bg-gray-100 text-gray-700'
          }`}
        >
          <Library size={18} />
          <span className="flex-1 text-left">全部书籍</span>
          <span className="text-xs text-gray-500">{totalBooks}</span>
        </button>

        {/* Uncategorized */}
        <button
          onClick={() => setSelectedFolderId(null)}
          className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors text-sm ${
            selectedFolderId === null
              ? 'bg-blue-100 text-blue-600'
              : 'hover:bg-gray-100 text-gray-700'
          }`}
        >
          <BookX size={18} />
          <span className="flex-1 text-left">未分类</span>
          <span className="text-xs text-gray-500">{uncategorizedCount}</span>
        </button>

        {folders.length > 0 && (
          <div className="my-2 border-t border-gray-200" />
        )}

        {/* Folder List */}
        {folders.map((folder) => (
          <div key={folder.id} className="relative group">
            {editingId === folder.id ? (
              <div className="flex items-center gap-1 px-2 py-1">
                <input
                  type="text"
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveEdit();
                    if (e.key === 'Escape') handleCancelEdit();
                  }}
                  className="flex-1 px-2 py-1 text-sm border border-blue-500 rounded focus:outline-none"
                  autoFocus
                />
                <button
                  onClick={handleSaveEdit}
                  className="p-1 text-green-600 hover:bg-green-100 rounded"
                >
                  <Check size={14} />
                </button>
                <button
                  onClick={handleCancelEdit}
                  className="p-1 text-gray-500 hover:bg-gray-100 rounded"
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <>
                <button
                  onClick={() => setSelectedFolderId(folder.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors text-sm ${
                    selectedFolderId === folder.id
                      ? 'bg-blue-100 text-blue-600'
                      : 'hover:bg-gray-100 text-gray-700'
                  }`}
                >
                  <Folder size={18} style={{ color: folder.color }} />
                  <span className="flex-1 text-left truncate">{folder.name}</span>
                  <span className="text-xs text-gray-500">{folder.book_count}</span>
                </button>

                {/* More Actions Button */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpenId(menuOpenId === folder.id ? null : folder.id);
                  }}
                  className="folder-menu-trigger absolute right-1 top-1/2 -translate-y-1/2 p-1 opacity-0 group-hover:opacity-100 hover:bg-gray-200 rounded transition-all"
                >
                  <MoreVertical size={14} />
                </button>

                {/* Dropdown Menu */}
                {menuOpenId === folder.id && (
                  <div className="folder-menu absolute right-0 top-full mt-1 w-28 bg-white border border-gray-200 rounded-lg shadow-lg z-20">
                      <button
                        onClick={() => handleStartEdit(folder)}
                        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-100 text-sm text-gray-700"
                      >
                        <Pencil size={14} /> 重命名
                      </button>
                      <button
                        onClick={() => {
                          setDeleteConfirmId(folder.id);
                          setMenuOpenId(null);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-red-50 text-red-600 text-sm"
                      >
                        <Trash2 size={14} /> 删除
                      </button>
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </nav>

      <ConfirmDialog
        isOpen={deleteConfirmId !== null}
        title="删除文件夹"
        message="删除后，文件夹内的书籍将变为未分类。确定要删除吗？"
        confirmText="删除"
        cancelText="取消"
        isDangerous
        isLoading={isDeleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteConfirmId(null)}
      />
    </aside>
  );
}
