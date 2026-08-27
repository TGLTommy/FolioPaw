import { Loader, Pause, Volume2 } from 'lucide-react';
import type { TtsPlayer } from '../hooks/useTtsPlayer';

const ACCENTS = {
  teal: {
    active: 'text-teal-600 bg-teal-50 dark:text-teal-400 dark:bg-teal-950/30',
    idle: 'text-gray-400 hover:text-teal-500 hover:bg-teal-50 dark:hover:bg-teal-950/30',
  },
  blue: {
    active: 'text-blue-600 bg-blue-50',
    idle: 'text-gray-400 hover:text-blue-600 hover:bg-blue-50',
  },
} as const;

interface TtsSpeakButtonProps {
  player: TtsPlayer;
  /** 播放目标标识：同一 id 再次点击表示暂停/继续 */
  ttsId: string;
  text: string | null | undefined;
  ariaLabel: string;
  size?: number;
  accent?: keyof typeof ACCENTS;
  className?: string;
}

/** 朗读按钮：idle→播放，playing→暂停，paused→继续；text 为空时不渲染 */
export default function TtsSpeakButton({
  player,
  ttsId,
  text,
  ariaLabel,
  size = 14,
  accent = 'teal',
  className = 'p-1.5 rounded-md',
}: TtsSpeakButtonProps) {
  if (!text) return null;

  const isActive = player.activeId === ttsId;
  const isLoading = isActive && player.status === 'loading';
  const isPlaying = isActive && player.status === 'playing';
  const label = isPlaying ? '暂停朗读' : isActive && player.status === 'paused' ? '继续朗读' : ariaLabel;
  const colors = ACCENTS[accent];

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        if (isPlaying) player.pause();
        else if (isActive && player.status === 'paused') player.resume();
        else void player.play(ttsId, text);
      }}
      disabled={isLoading}
      aria-label={label}
      title={label}
      className={`${className} transition-colors disabled:opacity-50 ${isActive ? colors.active : colors.idle}`}
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
