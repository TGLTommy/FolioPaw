import type { ModelServiceConfig } from './model-service-config.service';

const CONTEXT_SAFETY_RATIO = 0.8;
const MAX_OUTPUT_RATIO = 0.4;
const REQUEST_OVERHEAD_TOKENS = 256;

export interface ModelContextBudget {
  contextWindow: number;
  maxOutputTokens: number;
  promptTokens: number;
  inputTokens: number;
}

/**
 * Conservative tokenizer-independent estimate suitable for mixed Chinese and
 * English text. The additional context reserve absorbs model-specific token
 * boundaries and chat-template overhead.
 */
export function estimateTokenCount(value: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of value) {
    if (character.codePointAt(0)! <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 3 + nonAscii * 1.5);
}

export function getModelContextBudget(
  config: ModelServiceConfig,
  promptText: string,
  requestedMaxTokens: number = 4096,
): ModelContextBudget | null {
  if (!config.contextWindow) return null;

  const contextWindow = config.contextWindow;
  const maxOutputTokens = Math.max(
    1,
    Math.min(requestedMaxTokens, Math.floor(contextWindow * MAX_OUTPUT_RATIO)),
  );
  const promptTokens = estimateTokenCount(promptText) + REQUEST_OVERHEAD_TOKENS;
  const safeContextTokens = Math.floor(contextWindow * CONTEXT_SAFETY_RATIO);
  const inputTokens = Math.max(0, safeContextTokens - maxOutputTokens - promptTokens);
  return { contextWindow, maxOutputTokens, promptTokens, inputTokens };
}

export function textFitsTokenBudget(text: string, tokenBudget: number): boolean {
  return estimateTokenCount(text) <= tokenBudget;
}

export function truncateTextToTokenBudget(
  text: string,
  tokenBudget: number,
  suffix: string = '\n\n[内容已按本地模型上下文限制截断]',
): string {
  if (tokenBudget <= 0) return '';
  if (textFitsTokenBudget(text, tokenBudget)) return text;

  const suffixTokens = estimateTokenCount(suffix);
  const targetBudget = Math.max(1, tokenBudget - suffixTokens);
  const characters = Array.from(text);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokenCount(characters.slice(0, middle).join('')) <= targetBudget) low = middle;
    else high = middle - 1;
  }
  return `${characters.slice(0, low).join('').trimEnd()}${suffix}`;
}

export function splitTextByTokenBudget(text: string, tokenBudget: number): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  if (tokenBudget <= 0) return [];
  if (textFitsTokenBudget(normalized, tokenBudget)) return [normalized];

  const units = normalized.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';

  const pushUnit = (unit: string) => {
    const candidate = current ? `${current}\n\n${unit}` : unit;
    if (textFitsTokenBudget(candidate, tokenBudget)) {
      current = candidate;
      return;
    }
    if (current) {
      chunks.push(current);
      current = '';
    }
    if (textFitsTokenBudget(unit, tokenBudget)) {
      current = unit;
      return;
    }
    for (const hardChunk of hardSplit(unit, tokenBudget)) chunks.push(hardChunk);
  };

  for (const unit of units.length > 0 ? units : [normalized]) pushUnit(unit);
  if (current) chunks.push(current);
  return chunks;
}

function hardSplit(text: string, tokenBudget: number): string[] {
  const remaining = Array.from(text);
  const chunks: string[] = [];
  let offset = 0;
  while (offset < remaining.length) {
    let low = 1;
    let high = remaining.length - offset;
    let best = 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = remaining.slice(offset, offset + middle).join('');
      if (estimateTokenCount(candidate) <= tokenBudget) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    chunks.push(remaining.slice(offset, offset + best).join('').trim());
    offset += best;
  }
  return chunks.filter(Boolean);
}
