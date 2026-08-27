import { Readable } from 'node:stream';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

export const DEFAULT_TTS_VOICE = 'zh-CN-XiaoxiaoNeural';
export const TTS_MAX_TEXT_LENGTH = 10000;

export class TtsInputError extends Error {}

/**
 * 摘要以 Markdown 存储；朗读前去掉排版符号，避免读出「井号」「星号」等噪音。
 */
export function markdownToPlainText(markdown: string): string {
  return markdown
    // 代码围栏：保留代码内容，去掉 ``` 行
    .replace(/^```[^\n]*$/gm, '')
    // 水平分割线
    .replace(/^[ \t]*([-*_])[ \t]*(?:\1[ \t]*){2,}$/gm, '')
    // 标题与引用前缀
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    // 列表前缀（无序与有序）
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    .replace(/^[ \t]*\d+\.[ \t]+/gm, '')
    // 图片与链接：保留可读文字
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // 行内强调与行内代码
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    // 折叠空行并修剪
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n')
    .trim();
}

export const ttsService = {
  /**
   * 将 Markdown 摘要合成为 MP3 音频流（Microsoft Edge 在线语音服务，免费）。
   * 每次请求使用独立连接，音频流结束后自动关闭。
   */
  async synthesize(markdown: string): Promise<Readable> {
    const text = markdownToPlainText(markdown ?? '');
    if (!text) {
      throw new TtsInputError('朗读文本不能为空');
    }
    if (text.length > TTS_MAX_TEXT_LENGTH) {
      throw new TtsInputError(`朗读文本过长（超过 ${TTS_MAX_TEXT_LENGTH} 字符）`);
    }

    const tts = new MsEdgeTTS();
    await tts.setMetadata(DEFAULT_TTS_VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text);

    const closeConnection = () => tts.close();
    audioStream.once('close', closeConnection);
    audioStream.once('error', closeConnection);

    return audioStream;
  },
};
