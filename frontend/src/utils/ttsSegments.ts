export const TTS_SEGMENT_MAX_LENGTH = 600;

/**
 * 把长文本按句子边界切成不超过 maxLength 的段，供逐段语音合成使用。
 * 整段一次合成会让长摘要等待数分钟并触发前端超时；分段后首段几秒即可开播。
 * 段拼接结果与原文本（去首尾空白后）一致。
 */
export function splitTextForTts(text: string, maxLength = TTS_SEGMENT_MAX_LENGTH): string[] {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return [];

  // 按句末标点与换行切成原子片段（保留分隔符本身）
  const atoms = trimmed.split(/(?<=[。！？；.!?;\n])/);
  const segments: string[] = [];
  let current = '';

  const pushCurrent = () => {
    if (current) {
      segments.push(current);
      current = '';
    }
  };

  for (const atom of atoms) {
    let piece = atom;
    // 单个片段本身超长（无句界的长串）：强制按上限硬切
    while (piece.length > maxLength) {
      pushCurrent();
      segments.push(piece.slice(0, maxLength));
      piece = piece.slice(maxLength);
    }
    if (current.length + piece.length > maxLength) pushCurrent();
    current += piece;
  }
  pushCurrent();

  return segments;
}
