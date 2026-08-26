import { useState, useMemo, useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';

export interface TOCEntry {
  id: string;
  title: string;
  href: string;
  level: number;
  pageNumber?: number;
  children?: TOCEntry[];
}

interface TableOfContentsProps {
  toc: TOCEntry[] | null;
  isOpen: boolean;
  onClose: () => void;
  onNavigate: (pageNumber: number) => void;
  currentPage: number;
}

// Flatten TOC tree to find the active chapter and its parent path
function flattenToc(entries: TOCEntry[], parentIds: string[] = []): Array<{ entry: TOCEntry; parentIds: string[] }> {
  const result: Array<{ entry: TOCEntry; parentIds: string[] }> = [];
  for (const entry of entries) {
    result.push({ entry, parentIds });
    if (entry.children && entry.children.length > 0) {
      result.push(...flattenToc(entry.children, [...parentIds, entry.id]));
    }
  }
  return result;
}

export function TableOfContents({
  toc,
  isOpen,
  onClose,
  onNavigate,
  currentPage,
}: TableOfContentsProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const activeEntryRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Find the active chapter: the one with the largest pageNumber <= currentPage
  const activeEntryId = useMemo(() => {
    if (!toc || toc.length === 0) return null;
    const flat = flattenToc(toc);
    let bestMatch: { entry: TOCEntry; parentIds: string[] } | null = null;
    for (const item of flat) {
      if (item.entry.pageNumber && item.entry.pageNumber <= currentPage) {
        if (!bestMatch || item.entry.pageNumber > bestMatch.entry.pageNumber!) {
          bestMatch = item;
        }
      }
    }
    return bestMatch;
  }, [toc, currentPage]);

  // Auto-expand parents of the active entry and scroll to it when TOC opens
  useEffect(() => {
    if (isOpen && activeEntryId) {
      // Expand all parent nodes of the active entry
      setExpandedIds(prev => {
        const newExpanded = new Set(prev);
        for (const parentId of activeEntryId.parentIds) {
          newExpanded.add(parentId);
        }
        return newExpanded;
      });
      // Scroll to active entry after DOM update
      requestAnimationFrame(() => {
        activeEntryRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    }
  }, [isOpen, activeEntryId]);

  const toggleExpand = (id: string) => {
    const newExpanded = new Set(expandedIds);
    if (newExpanded.has(id)) {
      newExpanded.delete(id);
    } else {
      newExpanded.add(id);
    }
    setExpandedIds(newExpanded);
  };

  const handleNavigate = (pageNumber?: number) => {
    if (pageNumber) {
      onNavigate(pageNumber);
      // Optionally close the TOC after navigation
      // onClose();
    }
  };

  const renderTocEntry = (entry: TOCEntry, depth: number = 0) => {
    const hasChildren = entry.children && entry.children.length > 0;
    const isExpanded = expandedIds.has(entry.id);
    const isActive = activeEntryId?.entry.id === entry.id;

    return (
      <div key={entry.id} ref={isActive ? activeEntryRef : undefined}>
        <div
          className={`flex items-center gap-2 px-4 py-2 cursor-pointer hover:bg-blue-50 dark:hover:bg-gray-700 transition-colors ${
            isActive ? 'bg-blue-100 dark:bg-blue-900/30 border-l-4 border-blue-600' : ''
          }`}
          style={{ paddingLeft: `${12 + depth * 16}px` }}
        >
          {hasChildren ? (
            <button
              onClick={() => toggleExpand(entry.id)}
              className="flex-shrink-0 p-0 hover:bg-gray-300 dark:hover:bg-gray-600 rounded transition-colors"
            >
              {isExpanded ? (
                <ChevronDown size={16} className="text-gray-600 dark:text-gray-400" />
              ) : (
                <ChevronRight size={16} className="text-gray-600 dark:text-gray-400" />
              )}
            </button>
          ) : (
            <div className="w-4" />
          )}
          <button
            onClick={() => handleNavigate(entry.pageNumber)}
            className="flex-1 text-left text-sm text-gray-700 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 truncate"
            title={entry.title}
          >
            {entry.title}
          </button>
          {entry.pageNumber && (
            <span className="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">
              第 {entry.pageNumber} 页
            </span>
          )}
        </div>

        {hasChildren && isExpanded && (
          <div>
            {entry.children!.map((child) => renderTocEntry(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {/* Overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 dark:bg-black/70 z-40"
          onClick={onClose}
        />
      )}

      {/* Sidebar */}
      <div
        className={`fixed left-0 top-0 bottom-0 w-80 bg-white dark:bg-gray-800 shadow-xl transform transition-transform duration-300 z-50 flex flex-col ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <h2 className="text-lg font-bold text-gray-900 dark:text-white">目录</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
            aria-label="关闭目录"
          >
            <X size={20} className="text-gray-600 dark:text-gray-400" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto" ref={scrollContainerRef}>
          {toc && toc.length > 0 ? (
            <div className="py-2">
              {toc.map((entry) => renderTocEntry(entry, 0))}
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500 dark:text-gray-400">
              <p className="text-sm">没有目录信息</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
