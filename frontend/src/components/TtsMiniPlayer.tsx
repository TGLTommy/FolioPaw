import { Loader, Pause, Play, Square, Volume2 } from 'lucide-react';
import { useTtsPlayerStore } from '../stores/useTtsPlayerStore';

/**
 * 全局迷你播放条：朗读在后台进行时（合成中/播放中/已暂停）悬浮于右下角，
 * 关闭 AI 摘要弹窗后仍可控制播放。
 */
export default function TtsMiniPlayer() {
  const tts = useTtsPlayerStore();

  if (tts.status === 'idle') return null;

  const statusText = tts.status === 'loading' ? '正在合成…' : tts.status === 'playing' ? '播放中' : '已暂停';

  return (
    <div className="fixed bottom-4 right-4 z-[80] flex items-center gap-3 rounded-full border border-blue-200 bg-white/95 py-2 pl-4 pr-2 shadow-lg shadow-blue-600/10 backdrop-blur dark:border-blue-900 dark:bg-gray-900/95">
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-blue-600 text-white">
        {tts.status === 'loading' ? (
          <Loader size={15} className="animate-spin" />
        ) : (
          <Volume2 size={15} className={tts.status === 'playing' ? 'animate-pulse' : ''} />
        )}
      </div>
      <div className="min-w-0">
        <p className="max-w-[220px] truncate text-sm font-medium text-gray-900 dark:text-gray-100">
          {tts.activeLabel || '语音朗读'}
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400">{statusText}</p>
      </div>
      <div className="flex items-center gap-1">
        {tts.status === 'playing' && (
          <button
            onClick={() => tts.pause()}
            aria-label="暂停朗读"
            title="暂停朗读"
            className="rounded-full p-2 text-gray-500 transition-colors hover:bg-blue-50 hover:text-blue-600 dark:text-gray-400 dark:hover:bg-blue-950/40"
          >
            <Pause size={16} />
          </button>
        )}
        {tts.status === 'paused' && (
          <button
            onClick={() => tts.resume()}
            aria-label="继续朗读"
            title="继续朗读"
            className="rounded-full p-2 text-gray-500 transition-colors hover:bg-blue-50 hover:text-blue-600 dark:text-gray-400 dark:hover:bg-blue-950/40"
          >
            <Play size={16} />
          </button>
        )}
        <button
          onClick={() => tts.stop()}
          aria-label="停止朗读"
          title="停止朗读"
          className="rounded-full p-2 text-gray-500 transition-colors hover:bg-red-50 hover:text-red-500 dark:text-gray-400 dark:hover:bg-red-950/40"
        >
          <Square size={16} />
        </button>
      </div>
    </div>
  );
}
