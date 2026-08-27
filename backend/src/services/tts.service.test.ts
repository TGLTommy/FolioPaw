import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const setMetadataMock = vi.fn();
const toStreamMock = vi.fn();
const closeMock = vi.fn();

vi.mock('msedge-tts', () => ({
  MsEdgeTTS: vi.fn(function () {
    return {
      setMetadata: setMetadataMock,
      toStream: toStreamMock,
      close: closeMock,
    };
  }),
  OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'audio-24khz-48kbitrate-mono-mp3' },
}));

import {
  DEFAULT_TTS_VOICE,
  markdownToPlainText,
  TTS_MAX_TEXT_LENGTH,
  TtsInputError,
  ttsService,
} from './tts.service';

describe('markdownToPlainText', () => {
  it('strips heading markers and emphasis', () => {
    expect(markdownToPlainText('## 核心观点\n\n这本书**深入浅出**地讲解了*核心*概念。'))
      .toBe('核心观点\n这本书深入浅出地讲解了核心概念。');
  });

  it('strips list markers but keeps item text', () => {
    expect(markdownToPlainText('- 第一点\n* 第二点\n1. 第三点'))
      .toBe('第一点\n第二点\n第三点');
  });

  it('keeps link text, drops the URL, and unwraps inline code', () => {
    expect(markdownToPlainText('详见[第三章](https://example.com)与 `代码` 部分。'))
      .toBe('详见第三章与 代码 部分。');
  });

  it('strips blockquotes and horizontal rules', () => {
    expect(markdownToPlainText('> 引用一句话\n\n---\n\n正文继续。'))
      .toBe('引用一句话\n正文继续。');
  });

  it('unwraps fenced code blocks without their fences', () => {
    expect(markdownToPlainText('说明：\n\n```js\nconst a = 1;\n```\n\n结束。'))
      .toBe('说明：\nconst a = 1;\n结束。');
  });
});

describe('ttsService.synthesize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects empty text', async () => {
    await expect(ttsService.synthesize('   ')).rejects.toThrow(TtsInputError);
    await expect(ttsService.synthesize('   ')).rejects.toThrow('朗读文本不能为空');
  });

  it('rejects markdown that strips down to nothing', async () => {
    await expect(ttsService.synthesize('---\n\n***')).rejects.toThrow(TtsInputError);
  });

  it('rejects text longer than the limit', async () => {
    const longText = '好'.repeat(TTS_MAX_TEXT_LENGTH + 1);
    await expect(ttsService.synthesize(longText)).rejects.toThrow(TtsInputError);
    await expect(ttsService.synthesize(longText)).rejects.toThrow('朗读文本过长');
  });

  it('sends stripped plain text to the speech engine and returns its audio stream', async () => {
    const audioStream = Readable.from([Buffer.from('mp3-bytes')]);
    toStreamMock.mockReturnValue({ audioStream, metadataStream: null });

    const stream = await ttsService.synthesize('## 标题\n\n**正文**内容。');

    expect(setMetadataMock).toHaveBeenCalledWith(DEFAULT_TTS_VOICE, expect.anything());
    expect(toStreamMock).toHaveBeenCalledWith('标题\n正文内容。');
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    expect(Buffer.concat(chunks).toString()).toBe('mp3-bytes');
  });

  it('escapes XML special characters before sending to the speech engine', async () => {
    const audioStream = Readable.from([Buffer.from('mp3-bytes')]);
    toStreamMock.mockReturnValue({ audioStream, metadataStream: null });

    await ttsService.synthesize('损失下降 30% & 准确率 <90% 或 >95%。');

    expect(toStreamMock).toHaveBeenCalledWith('损失下降 30% &amp; 准确率 &lt;90% 或 &gt;95%。');
  });

  it('emits an error instead of ending silently when no audio is produced', async () => {
    const emptyStream = Readable.from([]);
    toStreamMock.mockReturnValue({ audioStream: emptyStream, metadataStream: null });

    const stream = await ttsService.synthesize('正文内容。');
    const outcome = await new Promise<string>((resolve) => {
      stream.on('data', () => {});
      stream.on('end', () => resolve('end'));
      stream.on('error', (err) => resolve(`error: ${err.message}`));
    });

    expect(outcome).toBe('error: 语音服务未返回音频，请稍后重试');
  });

  it('still ends normally when audio bytes were produced', async () => {
    const audioStream = Readable.from([Buffer.from('mp3-bytes')]);
    toStreamMock.mockReturnValue({ audioStream, metadataStream: null });

    const stream = await ttsService.synthesize('正文内容。');
    const chunks: Buffer[] = [];
    const outcome = await new Promise<string>((resolve) => {
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve('end'));
      stream.on('error', (err) => resolve(`error: ${err.message}`));
    });

    expect(outcome).toBe('end');
    expect(Buffer.concat(chunks).toString()).toBe('mp3-bytes');
  });

  it('closes the connection once the audio stream ends', async () => {
    const audioStream = Readable.from([Buffer.from('mp3-bytes')]);
    toStreamMock.mockReturnValue({ audioStream, metadataStream: null });

    const stream = await ttsService.synthesize('正文内容。');
    stream.emit('close');

    expect(closeMock).toHaveBeenCalled();
  });
});
