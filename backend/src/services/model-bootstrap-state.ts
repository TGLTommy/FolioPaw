export type ModelBootstrapPhase =
  | 'disabled'
  | 'waiting'
  | 'checking'
  | 'pulling-official'
  | 'downloading-modelscope'
  | 'verifying'
  | 'importing'
  | 'testing'
  | 'ready'
  | 'failed'
  | 'unavailable';

export type ModelBootstrapSource = 'ollama-registry' | 'modelscope' | 'local' | null;

export interface ModelBootstrapStatus {
  enabled: boolean;
  phase: ModelBootstrapPhase;
  source: ModelBootstrapSource;
  model: string;
  receivedBytes: number | null;
  totalBytes: number | null;
  percent: number | null;
  message: string;
  updatedAt: string;
  canRetry: boolean;
}

let currentStatus: ModelBootstrapStatus = {
  enabled: false,
  phase: 'disabled',
  source: null,
  model: '',
  receivedBytes: null,
  totalBytes: null,
  percent: null,
  message: 'Docker 本地模型引导未启用',
  updatedAt: new Date().toISOString(),
  canRetry: false,
};

export function setCachedModelBootstrapStatus(status: ModelBootstrapStatus): void {
  currentStatus = status;
}

export function getCachedModelBootstrapStatus(): ModelBootstrapStatus {
  return { ...currentStatus };
}
