export interface TOCEntry {
  id: string;
  title: string;
  href: string;
  level: number;
  pageNumber?: number;
  children?: TOCEntry[];
}

export interface Folder {
  id: number;
  name: string;
  color: string;
  sort_order: number;
  book_count: number;
  created_at: string;
  updated_at: string;
}

export type ReadingStatus = 'unread' | 'reading' | 'paused' | 'finished' | 'abandoned';
export type TextExtractionStatus = 'ready' | 'partial' | 'unavailable';
export type BookImportStatus = 'pending' | 'processing' | 'ready' | 'failed';

export interface Book {
  id: number;
  filename: string;
  original_name: string;
  file_url: string;
  file_type: 'pdf' | 'epub';
  file_size: number;
  total_pages: number;
  upload_time: string;
  last_read_page: number;
  translation_status: 'pending' | 'translating' | 'completed' | 'failed';
  translated_pages?: number;
  text_extraction_status: TextExtractionStatus;
  text_page_count: number;
  reading_guide_status?: 'pending' | 'generating' | 'completed' | 'failed' | 'cancelled' | null;
  has_reading_guide?: number | null;
  tableOfContents?: TOCEntry[] | null;
  folder_id: number | null;
  folder_name?: string;
  folder_color?: string;
  cover_image_path?: string | null;
  is_pinned?: number;
  reading_status?: ReadingStatus;
  import_status?: BookImportStatus;
  import_stage?: string | null;
  import_error?: string | null;
  import_started_at?: string | null;
  import_completed_at?: string | null;
}

export interface Page {
  id: number;
  book_id: number;
  page_number: number;
  original_text: string;
  translated_text: string | null;
  translation_status: 'pending' | 'translating' | 'completed' | 'failed' | 'skipped';
  created_at: string;
  updated_at: string;
}

export interface ReadingGuide {
  id: number;
  book_id: number;
  guide_text: string | null;
  status: 'pending' | 'generating' | 'completed' | 'failed' | 'cancelled';
  error_message: string | null;
  model_used: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserConfig {
  theme: 'light' | 'dark';
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
  defaultSourceLang: string;
  defaultTargetLang: string;
}

export type ModelProviderType = 'openai-compatible' | 'anthropic-compatible' | 'ollama';
export type ModelTestStatus = 'untested' | 'success' | 'failed';
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

export interface ModelServiceConfig {
  id: number;
  name: string;
  providerType: ModelProviderType;
  model: string;
  baseUrl: string | null;
  hasApiKey: boolean;
  contextWindow: number | null;
  isManaged: boolean;
  timeoutMs: number;
  maxConcurrency: number;
  isActive: boolean;
  isInUse: boolean;
  revision: number;
  testStatus: ModelTestStatus;
  testedRevision: number | null;
  lastTestMessage: string | null;
  lastTestStatusCode: number | null;
  lastTestResponseMs: number | null;
  lastTestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelServiceConfigInput {
  name: string;
  providerType: ModelProviderType;
  model: string;
  baseUrl?: string | null;
  apiKey?: string;
  contextWindow?: number | null;
  timeoutMs: number;
  maxConcurrency: number;
}

export interface ModelBootstrapStatus {
  enabled: boolean;
  phase: ModelBootstrapPhase;
  source: 'ollama-registry' | 'modelscope' | 'local' | null;
  model: string;
  receivedBytes: number | null;
  totalBytes: number | null;
  percent: number | null;
  message: string;
  updatedAt: string;
  canRetry: boolean;
}

export interface ModelServiceTestResult {
  success: boolean;
  provider: string;
  providerType: ModelProviderType;
  model: string;
  message: string;
  responseTime?: number;
  statusCode?: number;
  error?: string;
  config: ModelServiceConfig;
}
