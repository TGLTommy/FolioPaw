import { useCallback, useEffect, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import type { Folder } from '../types/index';
import { folderApi } from '../services/api';
import { useToast } from '../contexts/useToast';
import { getApiErrorMessage } from '../utils/error';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (folder: Folder) => void;
}

const PRESET_COLORS = [
  '#3B82F6', // blue
  '#10B981', // green
  '#F59E0B', // amber
  '#EF4444', // red
  '#8B5CF6', // purple
  '#EC4899', // pink
  '#06B6D4', // cyan
  '#F97316', // orange
];

export default function CreateFolderDialog({ isOpen, onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(PRESET_COLORS[0]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const { addToast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('请输入文件夹名称');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      const response = await folderApi.create({ name: name.trim(), color });
      onCreated(response.data.data);
      addToast('文件夹创建成功', 'success');
      handleClose();
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, '创建失败'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleClose = useCallback(() => {
    setName('');
    setColor(PRESET_COLORS[0]);
    setError('');
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!isOpen || isLoading) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handleClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isLoading, handleClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={handleClose}
      />

      {/* Dialog */}
      <div
        className="relative z-10 bg-white rounded-xl shadow-xl w-full max-w-md mx-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-folder-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 id="create-folder-title" className="text-lg font-semibold text-gray-900">新建文件夹</h2>
          <button
            onClick={handleClose}
            className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <form onSubmit={handleSubmit} className="p-6">
          {/* Name Input */}
          <div className="mb-4">
            <label
              htmlFor="folderName"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              文件夹名称
            </label>
            <input
              id="folderName"
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError('');
              }}
              placeholder="例如：技术书、待读书单"
              className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                error ? 'border-red-500' : 'border-gray-300'
              }`}
              maxLength={50}
              autoFocus
            />
            {error && (
              <p className="mt-1 text-sm text-red-500">{error}</p>
            )}
          </div>

          {/* Color Picker */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              选择颜色
            </label>
            <div className="flex flex-wrap gap-2">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={`w-8 h-8 rounded-full transition-all ${
                    color === c
                      ? 'ring-2 ring-offset-2 ring-blue-500 scale-110'
                      : 'hover:scale-105'
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={handleClose}
              className="px-4 py-2 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
              disabled={isLoading}
            >
              取消
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={isLoading || !name.trim()}
            >
              {isLoading && <Loader2 size={16} className="animate-spin" />}
              创建
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
