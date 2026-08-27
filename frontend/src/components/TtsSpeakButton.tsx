import { Loader, Pause, Play, Volume2 } from 'lucide-react';
import type { TtsPlayer } from '../stores/useTtsPlayerStore';

const ACCENTS = {
  teal: {
    active: 'text-teal-600 bg-teal-50 dark:text-teal-400 dark:bg-teal-950/30',
    idle: 'text-teal-600 hover:bg-teal-50 dark:text-teal-400 dark:hover:bg-teal-950/30',
  },
  blue: {
    active: 'text-blue-600 bg-blue-50',
    idle: 'text-blue-600 hover:bg-blue-50',
  },
} as const;

interface TtsSpeakButtonProps {
  player: TtsPlayer;
  /** 播放目标标识：同一 id 再次点击表示暂停/继续 */
  ttsId: string;
  text: string | null | undefined;
  ariaLabel: string;
  /** 全局迷你播放条上显示的内容名称 */
  label?: string;
  size?: number;
  accent?: keyof typeof ACCENTS;
  className?: string;
  /** labeled：带文字的醒目按钮（用于弹窗头部）；icon：紧凑图标按钮（用于列表行） */
  variant?: 'icon' | 'labeled';
}

/** 朗读按钮：idle→播放，playing→暂停，paused→继续；text 为空时不渲染 */
export default function TtsSpeakButton({
  player,
  ttsId,
  text,
  ariaLabel,
  label,
  size = 14,
  accent = 'teal',
  className,
  variant = 'icon',
}: TtsSpeakButtonProps) {
  if (!text) return null;

  const isActive = player.activeId === ttsId;
  const isLoading = isActive && player.status === 'loading';
  const isPlaying = isActive && player.status === 'playing';
  const isPaused = isActive && player.status === 'paused';
  const buttonLabel = isPlaying ? '暂停朗读' : isPaused ? '继续朗读' : ariaLabel;
  const colors = ACCENTS[accent];

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isPlaying) player.pause();
    else if (isPaused) player.resume();
    else void player.play(ttsId, text, label);
  };

  if (variant === 'labeled') {
    return (
      <button
        onClick={handleClick}
        disabled={isLoading}
        aria-label={buttonLabel}
        title={buttonLabel}
        className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${
          isActive
            ? 'bg-blue-600 text-white hover:bg-blue-700'
            : 'border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100'
        } ${className ?? ''}`}
      >
        {isLoading ? (
          <Loader size={size} className="animate-spin" />
        ) : isPlaying ? (
          <Pause size={size} />
        ) : isPaused ? (
          <Play size={size} />
        ) : (
          <Volume2 size={size} />
        )}
        {isLoading ? '正在合成…' : isPlaying ? '暂停' : isPaused ? '继续' : '朗读'}
      </button>
    );
  }

  return (
    <button
      onClick={handleClick}
      disabled={isLoading}
      aria-label={buttonLabel}
      title={buttonLabel}
      className={`${className ?? 'p-1.5 rounded-md'} transition-colors disabled:opacity-50 ${
        isActive ? colors.active : colors.idle
      }`}
    >
      {isLoading ? (
        <Loader size={size} className="animate-spin" />
      ) : isPlaying ? (
        <Pause size={size} />
      ) : (
        <Volume2 size={size} />
      )}
    </button>
  );
}
