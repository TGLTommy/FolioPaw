import { TTS_PLAYBACK_RATES, useTtsPlayerStore } from '../stores/useTtsPlayerStore';

/** 播放倍速循环切换按钮：1x → 1.25x → 1.5x → 2x → 0.75x */
export default function TtsRateButton({ className }: { className?: string }) {
  const rate = useTtsPlayerStore((state) => state.playbackRate);
  const setPlaybackRate = useTtsPlayerStore((state) => state.setPlaybackRate);

  const cycleRate = () => {
    const index = TTS_PLAYBACK_RATES.indexOf(rate as (typeof TTS_PLAYBACK_RATES)[number]);
    setPlaybackRate(TTS_PLAYBACK_RATES[(index + 1) % TTS_PLAYBACK_RATES.length]);
  };

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        cycleRate();
      }}
      aria-label="播放倍速"
      title="播放倍速"
      className={
        className
        ?? 'rounded-full px-2 py-1.5 text-xs font-semibold tabular-nums text-gray-500 transition-colors hover:bg-blue-50 hover:text-blue-600 dark:text-gray-400 dark:hover:bg-blue-950/40'
      }
    >
      {rate}x
    </button>
  );
}
