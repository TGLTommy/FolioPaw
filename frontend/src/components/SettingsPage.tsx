import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  CircleSlash2,
  Cloud,
  Copy,
  Cpu,
  Download,
  Edit3,
  KeyRound,
  Loader,
  Plus,
  RefreshCw,
  Save,
  Server,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { modelServiceApi } from '../services/api';
import type {
  ModelProviderType,
  ModelBootstrapStatus,
  ModelServiceConfig,
  ModelServiceConfigInput,
  ModelServiceTestResult,
} from '../types';
import { useToast } from '../contexts/useToast';
import { getApiErrorMessage } from '../utils/error';
import APITestResultDialog from './APITestResultDialog';
import ConfirmDialog from './ConfirmDialog';

interface FormState {
  name: string;
  providerType: ModelProviderType;
  model: string;
  baseUrl: string;
  apiKey: string;
  timeoutSeconds: number;
  maxConcurrency: number;
  contextWindow: number;
}

const DEFAULT_FORM: FormState = {
  name: '',
  providerType: 'openai-compatible',
  model: '',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  timeoutSeconds: 180,
  maxConcurrency: 1,
  contextWindow: 32768,
};

const PROVIDER_META: Record<ModelProviderType, {
  label: string;
  description: string;
  icon: typeof Cloud;
  color: string;
}> = {
  'openai-compatible': {
    label: 'OpenAI 兼容',
    description: '使用 Chat Completions 兼容接口',
    icon: Cloud,
    color: 'text-blue-600 bg-blue-50 dark:bg-blue-900/20',
  },
  'anthropic-compatible': {
    label: 'Anthropic 兼容',
    description: '使用 Messages API 兼容接口',
    icon: Server,
    color: 'text-violet-600 bg-violet-50 dark:bg-violet-900/20',
  },
  ollama: {
    label: 'Ollama 本地',
    description: '无需 API Key，可在断网环境中运行本地模型',
    icon: Cpu,
    color: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20',
  },
};

export default function SettingsPage() {
  const [configs, setConfigs] = useState<ModelServiceConfig[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [isSaving, setIsSaving] = useState(false);
  const [actionId, setActionId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ModelServiceConfig | null>(null);
  const [testResult, setTestResult] = useState<ModelServiceTestResult | null>(null);
  const [isTestDialogOpen, setIsTestDialogOpen] = useState(false);
  const [bootstrapStatus, setBootstrapStatus] = useState<ModelBootstrapStatus | null>(null);
  const [isRetryingBootstrap, setIsRetryingBootstrap] = useState(false);
  const { addToast } = useToast();

  const loadConfigs = useCallback(async (showError = true) => {
    try {
      const response = await modelServiceApi.list();
      setConfigs(response.data.data);
    } catch (error) {
      if (showError) addToast(getApiErrorMessage(error, '模型服务配置加载失败'), 'error');
    } finally {
      setIsLoading(false);
    }
  }, [addToast]);

  const loadBootstrapStatus = useCallback(async (showError = false) => {
    try {
      const response = await modelServiceApi.bootstrapStatus();
      setBootstrapStatus(response.data.data);
    } catch (error) {
      if (showError) addToast(getApiErrorMessage(error, '本地模型状态加载失败'), 'error');
    }
  }, [addToast]);

  useEffect(() => {
    void loadConfigs();
    void loadBootstrapStatus();
    const timer = window.setInterval(() => {
      void loadBootstrapStatus();
      void loadConfigs(false);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [loadBootstrapStatus, loadConfigs]);

  const activeConfig = useMemo(
    () => configs.find((config) => config.isActive) || null,
    [configs],
  );

  const openCreate = () => {
    setEditingId(null);
    setForm(DEFAULT_FORM);
    setIsFormOpen(true);
  };

  const openEdit = (config: ModelServiceConfig) => {
    setEditingId(config.id);
    setForm(formFromConfig(config, false));
    setIsFormOpen(true);
  };

  const openCopy = (config: ModelServiceConfig) => {
    setEditingId(null);
    setForm({
      ...formFromConfig(config, true),
      name: `${config.name} 副本`,
    });
    setIsFormOpen(true);
  };

  const closeForm = () => {
    if (isSaving) return;
    setIsFormOpen(false);
    setEditingId(null);
    setForm(DEFAULT_FORM);
  };

  const changeProvider = (providerType: ModelProviderType) => {
    setForm((current) => ({
      ...current,
      providerType,
      baseUrl: providerType === 'openai-compatible'
        ? 'https://api.openai.com/v1'
        : providerType === 'anthropic-compatible'
          ? 'https://api.anthropic.com'
          : 'http://127.0.0.1:11434',
      model: providerType === 'ollama' ? 'qwen3.5:4b' : '',
      apiKey: '',
      timeoutSeconds: providerType === 'ollama' ? 1800 : 180,
      maxConcurrency: 1,
      contextWindow: 32768,
    }));
  };

  const saveConfig = async (event: React.FormEvent) => {
    event.preventDefault();
    if (form.providerType !== 'ollama' && !editingId && !form.apiKey.trim()) {
      addToast('新建 API 配置时必须填写 API Key', 'warning');
      return;
    }

    setIsSaving(true);
    try {
      const input = toApiInput(form);
      if (editingId) {
        await modelServiceApi.update(editingId, input);
        addToast('配置已更新，请重新测试后启用', 'success');
      } else {
        await modelServiceApi.create(input);
        addToast('配置已保存，请先测试连接', 'success');
      }
      closeFormAfterSave();
      await loadConfigs(false);
    } catch (error) {
      addToast(getApiErrorMessage(error, '配置保存失败'), 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const retryBootstrap = async () => {
    setIsRetryingBootstrap(true);
    try {
      const response = await modelServiceApi.retryBootstrap();
      setBootstrapStatus(response.data.data);
      addToast('已重新启动本地模型准备任务', 'success');
    } catch (error) {
      addToast(getApiErrorMessage(error, '本地模型重试失败'), 'error');
    } finally {
      setIsRetryingBootstrap(false);
    }
  };

  const closeFormAfterSave = () => {
    setIsFormOpen(false);
    setEditingId(null);
    setForm(DEFAULT_FORM);
  };

  const testConfig = async (config: ModelServiceConfig) => {
    setActionId(config.id);
    try {
      const response = await modelServiceApi.test(config.id);
      setTestResult(response.data.data);
      setIsTestDialogOpen(true);
      await loadConfigs(false);
    } catch (error) {
      addToast(getApiErrorMessage(error, '连接测试失败'), 'error');
    } finally {
      setActionId(null);
    }
  };

  const activateConfig = async (config: ModelServiceConfig) => {
    setActionId(config.id);
    try {
      await modelServiceApi.activate(config.id);
      addToast(`已启用“${config.name}”`, 'success');
      await loadConfigs(false);
    } catch (error) {
      addToast(getApiErrorMessage(error, '配置启用失败'), 'error');
    } finally {
      setActionId(null);
    }
  };

  const deleteConfig = async () => {
    if (!deleteTarget) return;
    setActionId(deleteTarget.id);
    try {
      await modelServiceApi.remove(deleteTarget.id);
      addToast('配置已删除', 'success');
      setDeleteTarget(null);
      await loadConfigs(false);
    } catch (error) {
      addToast(getApiErrorMessage(error, '配置删除失败'), 'error');
    } finally {
      setActionId(null);
    }
  };

  return (
    <div className="min-h-[calc(100vh-73px)] bg-slate-50 dark:bg-gray-900 px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="mb-2 text-sm font-semibold tracking-[0.18em] text-blue-600">模型设置</p>
            <h2 className="text-3xl font-bold text-gray-900 dark:text-white">模型服务</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-600 dark:text-gray-400">
              管理 FolioPaw 用于翻译、AI 问答、摘要与思维导图的统一模型服务。
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => {
                void loadConfigs();
                void loadBootstrapStatus(true);
              }}
              disabled={isLoading}
              className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 shadow-sm transition hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              <RefreshCw size={17} className={isLoading ? 'animate-spin' : ''} />
              刷新
            </button>
            <button
              onClick={openCreate}
              className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700"
            >
              <Plus size={18} />
              新增配置
            </button>
          </div>
        </header>

        <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800/60 dark:bg-amber-900/20 dark:text-amber-200">
          <AlertTriangle size={19} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">模型能力由本地 Ollama 或你配置的第三方 API 提供</p>
            <p className="mt-1 text-amber-800/80 dark:text-amber-200/70">
              本应用没有账号与访问控制。第三方 API Key 保存在本机数据库中且不会回显；请勿将服务暴露到不受信任的网络。
            </p>
          </div>
        </div>

        {bootstrapStatus?.enabled && (
          <BootstrapStatusCard
            status={bootstrapStatus}
            isRetrying={isRetryingBootstrap}
            onRetry={() => void retryBootstrap()}
          />
        )}

        <section className="overflow-hidden rounded-3xl bg-gradient-to-br from-slate-950 via-blue-950 to-indigo-950 p-6 text-white shadow-xl">
          <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-300">当前激活服务</p>
              {activeConfig ? (
                <>
                  <h3 className="mt-3 text-2xl font-bold">{activeConfig.name}</h3>
                  <p className="mt-2 text-sm text-blue-100/80">
                    {PROVIDER_META[activeConfig.providerType].label} · {activeConfig.model}
                  </p>
                </>
              ) : (
                <p className="mt-3 text-lg font-semibold text-amber-300">暂无激活配置</p>
              )}
            </div>
            {activeConfig && (
              <div className="min-w-0 rounded-2xl border border-white/10 bg-white/10 px-4 py-3 backdrop-blur md:max-w-md">
                <p className="truncate font-mono text-xs text-blue-100">
                  {activeConfig.baseUrl}
                </p>
                <div className="mt-2 flex items-center gap-2 text-xs text-blue-200">
                  <Zap size={14} />
                  超时 {Math.round(activeConfig.timeoutMs / 1000)} 秒 · 最大并发 {activeConfig.maxConcurrency}
                </div>
              </div>
            )}
          </div>
        </section>

        {isLoading ? (
          <div className="flex min-h-64 items-center justify-center rounded-2xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
            <Loader size={28} className="animate-spin text-blue-600" />
          </div>
        ) : configs.length === 0 ? (
          <div className="rounded-2xl border-2 border-dashed border-gray-300 bg-white px-6 py-16 text-center dark:border-gray-700 dark:bg-gray-800">
            <CircleSlash2 size={36} className="mx-auto text-gray-400" />
            <h3 className="mt-4 font-semibold text-gray-900 dark:text-white">还没有模型服务配置</h3>
            <p className="mt-2 text-sm text-gray-500">创建并测试一套配置后即可启用。</p>
          </div>
        ) : (
          <section className="grid gap-4 lg:grid-cols-2">
            {configs.map((config) => (
              <ConfigCard
                key={config.id}
                config={config}
                isBusy={actionId === config.id}
                onTest={() => void testConfig(config)}
                onActivate={() => void activateConfig(config)}
                onEdit={() => openEdit(config)}
                onCopy={() => openCopy(config)}
                onDelete={() => setDeleteTarget(config)}
              />
            ))}
          </section>
        )}
      </div>

      {isFormOpen && (
        <ConfigForm
          form={form}
          setForm={setForm}
          editingConfig={editingId ? configs.find((config) => config.id === editingId) || null : null}
          isSaving={isSaving}
          onProviderChange={changeProvider}
          onSubmit={saveConfig}
          onClose={closeForm}
        />
      )}

      <APITestResultDialog
        isOpen={isTestDialogOpen}
        result={testResult}
        isLoading={false}
        onClose={() => setIsTestDialogOpen(false)}
      />

      <ConfirmDialog
        isOpen={Boolean(deleteTarget)}
        title="删除模型服务配置"
        message={`确定删除“${deleteTarget?.name || ''}”吗？此操作不会删除已经生成的译文或摘要。`}
        confirmText="删除"
        isDangerous
        isLoading={Boolean(deleteTarget && actionId === deleteTarget.id)}
        onConfirm={() => void deleteConfig()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

const BOOTSTRAP_PHASE_LABELS: Record<ModelBootstrapStatus['phase'], string> = {
  disabled: '未启用',
  waiting: '等待 Ollama',
  checking: '检查本地模型',
  'pulling-official': 'Ollama 官方源下载',
  'downloading-modelscope': 'ModelScope 国内回退下载',
  verifying: '校验模型',
  importing: '导入 Ollama',
  testing: '测试模型',
  ready: '本地模型已就绪',
  failed: '模型准备失败',
  unavailable: '引导服务不可用',
};

function BootstrapStatusCard({
  status,
  isRetrying,
  onRetry,
}: {
  status: ModelBootstrapStatus;
  isRetrying: boolean;
  onRetry: () => void;
}) {
  const isReady = status.phase === 'ready';
  const isFailed = status.phase === 'failed' || status.phase === 'unavailable';
  const source = status.source === 'modelscope'
    ? 'ModelScope'
    : status.source === 'ollama-registry'
      ? 'Ollama 官方源'
      : status.source === 'local'
        ? '本地 GGUF'
        : null;

  return (
    <section className={`rounded-2xl border p-5 shadow-sm ${
      isReady
        ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-800/60 dark:bg-emerald-900/20'
        : isFailed
          ? 'border-red-200 bg-red-50 dark:border-red-800/60 dark:bg-red-900/20'
          : 'border-blue-200 bg-blue-50 dark:border-blue-800/60 dark:bg-blue-900/20'
    }`}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className={`rounded-xl p-2.5 ${isReady ? 'bg-emerald-100 text-emerald-700' : isFailed ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'}`}>
            {isReady ? <CheckCircle2 size={21} /> : isFailed ? <AlertTriangle size={21} /> : <Download size={21} />}
          </div>
          <div className="min-w-0">
            <p className="font-bold text-gray-900 dark:text-white">{BOOTSTRAP_PHASE_LABELS[status.phase]}</p>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{status.message}</p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
              <span>模型 {status.model}</span>
              {source && <span>来源 {source}</span>}
              {status.receivedBytes !== null && status.totalBytes !== null && (
                <span>{formatBytes(status.receivedBytes)} / {formatBytes(status.totalBytes)}</span>
              )}
            </div>
          </div>
        </div>
        {status.canRetry && (
          <button
            type="button"
            onClick={onRetry}
            disabled={isRetrying}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
          >
            <RefreshCw size={16} className={isRetrying ? 'animate-spin' : ''} />
            {isRetrying ? '重试中...' : '重试下载'}
          </button>
        )}
      </div>
      {!isReady && !isFailed && (
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/80 dark:bg-gray-800">
          <div
            className={`h-full rounded-full bg-blue-600 transition-all ${status.percent === null ? 'w-1/3 animate-pulse' : ''}`}
            style={status.percent === null ? undefined : { width: `${status.percent}%` }}
          />
        </div>
      )}
      <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
        首次启动需要下载模型；准备完成后模型保存在 Docker 卷中，断网重启仍可使用。
      </p>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`;
}

function ConfigCard({
  config,
  isBusy,
  onTest,
  onActivate,
  onEdit,
  onCopy,
  onDelete,
}: {
  config: ModelServiceConfig;
  isBusy: boolean;
  onTest: () => void;
  onActivate: () => void;
  onEdit: () => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const provider = PROVIDER_META[config.providerType];
  const ProviderIcon = provider.icon;
  const canActivate = !config.isActive
    && config.testStatus === 'success'
    && config.testedRevision === config.revision;
  const isLocked = config.isActive || config.isInUse;

  return (
    <article className={`rounded-2xl border bg-white p-5 shadow-sm transition dark:bg-gray-800 ${
      config.isActive
        ? 'border-blue-400 ring-2 ring-blue-100 dark:border-blue-600 dark:ring-blue-900/40'
        : 'border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600'
    }`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className={`rounded-xl p-2.5 ${provider.color}`}>
            <ProviderIcon size={21} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate font-bold text-gray-900 dark:text-white">{config.name}</h3>
              {config.isActive && (
                <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                  <Check size={12} /> 已激活
                </span>
              )}
              {config.isInUse && !config.isActive && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">任务使用中</span>
              )}
              {config.isManaged && (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">Docker 托管</span>
              )}
            </div>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{provider.label} · {config.model}</p>
          </div>
        </div>
        <TestBadge config={config} />
      </div>

      <div className="mt-4 rounded-xl bg-gray-50 px-3 py-2.5 dark:bg-gray-900/60">
        <p className="truncate font-mono text-xs text-gray-600 dark:text-gray-300">
          {config.baseUrl}
        </p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
          <span>超时 {Math.round(config.timeoutMs / 1000)} 秒</span>
          <span>并发 {config.maxConcurrency}</span>
          {config.contextWindow && <span>上下文 {config.contextWindow.toLocaleString()} 词元</span>}
          <span className="inline-flex items-center gap-1">
            <KeyRound size={12} />
            {config.providerType === 'ollama' ? '无需 API Key' : config.hasApiKey ? 'Key 已配置' : '缺少 Key'}
          </span>
        </div>
      </div>

      {config.lastTestMessage && (
        <p className={`mt-3 line-clamp-2 text-xs ${config.testStatus === 'failed' ? 'text-red-600' : 'text-gray-500 dark:text-gray-400'}`}>
          {config.lastTestMessage}
        </p>
      )}

      <div className="mt-5 flex flex-wrap gap-2 border-t border-gray-100 pt-4 dark:border-gray-700">
        <ActionButton onClick={onTest} disabled={isBusy} icon={isBusy ? Loader : Zap} label="测试" spin={isBusy} />
        {!config.isActive && (
          <ActionButton onClick={onActivate} disabled={!canActivate || isBusy} icon={CheckCircle2} label="启用" primary />
        )}
        <ActionButton onClick={onCopy} disabled={isBusy} icon={Copy} label="复制" />
        {!config.isActive && (
          <ActionButton onClick={onEdit} disabled={isLocked || config.isManaged || isBusy} icon={Edit3} label="编辑" />
        )}
        {!config.isActive && (
          <ActionButton onClick={onDelete} disabled={isLocked || config.isManaged || isBusy} icon={Trash2} label="删除" danger />
        )}
      </div>
    </article>
  );
}

function ConfigForm({
  form,
  setForm,
  editingConfig,
  isSaving,
  onProviderChange,
  onSubmit,
  onClose,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  editingConfig: ModelServiceConfig | null;
  isSaving: boolean;
  onProviderChange: (provider: ModelProviderType) => void;
  onSubmit: (event: React.FormEvent) => void;
  onClose: () => void;
}) {
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-sm" role="dialog" aria-modal="true">
      <button className="flex-1 cursor-default" onClick={onClose} aria-label="关闭配置表单" />
      <div className="h-full w-full max-w-xl overflow-y-auto bg-white shadow-2xl dark:bg-gray-800">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-200 bg-white/95 px-6 py-5 backdrop-blur dark:border-gray-700 dark:bg-gray-800/95">
          <div>
            <h3 className="text-xl font-bold text-gray-900 dark:text-white">{editingConfig ? '编辑配置' : '新增配置'}</h3>
            <p className="mt-1 text-xs text-gray-500">保存后需要连接测试成功；没有其他激活服务时会自动启用</p>
          </div>
          <button onClick={onClose} disabled={isSaving} className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={onSubmit} className="space-y-6 p-6">
          <Field label="配置名称" required>
            <input className={INPUT_CLASS} value={form.name} onChange={(event) => set('name', event.target.value)} placeholder="例如：公司 OpenAI 网关" required />
          </Field>

          <Field label="服务类型" required>
            <div className="grid gap-2 sm:grid-cols-3">
              {(Object.keys(PROVIDER_META) as ModelProviderType[]).map((providerType) => {
                const meta = PROVIDER_META[providerType];
                const Icon = meta.icon;
                return (
                  <button
                    key={providerType}
                    type="button"
                    onClick={() => onProviderChange(providerType)}
                    className={`rounded-xl border p-3 text-left transition ${
                      form.providerType === providerType
                        ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-100 dark:bg-blue-900/20 dark:ring-blue-900/40'
                        : 'border-gray-200 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700'
                    }`}
                  >
                    <Icon size={19} className={form.providerType === providerType ? 'text-blue-600' : 'text-gray-500'} />
                    <span className="mt-2 block text-xs font-semibold text-gray-800 dark:text-gray-200">{meta.label}</span>
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-gray-500">{PROVIDER_META[form.providerType].description}</p>
          </Field>

          <Field label="模型名称" required hint={form.providerType === 'ollama' ? '填写 Ollama 模型标签，例如 qwen3.5:4b。' : '使用服务商提供的精确模型 ID，不会自动拉取模型列表。'}>
            <input className={INPUT_CLASS} value={form.model} onChange={(event) => set('model', event.target.value)} placeholder="模型 ID" required />
          </Field>

          <Field label="API 地址" required hint={form.providerType === 'ollama' ? '原生 Ollama 默认地址为 http://127.0.0.1:11434。' : '可填写基础 URL，也可填写完整的 chat/completions 或 messages 地址。'}>
            <input className={INPUT_CLASS} type="url" value={form.baseUrl} onChange={(event) => set('baseUrl', event.target.value)} placeholder="https://api.example.com/v1" required />
          </Field>
          {form.providerType !== 'ollama' && (
            <Field
              label="API Key"
              required={!editingConfig}
              hint={editingConfig?.hasApiKey ? '已保存 API Key；留空表示继续使用原 Key。' : '密钥只提交给后端，不会从接口回显。'}
            >
              <input className={INPUT_CLASS} type="password" value={form.apiKey} onChange={(event) => set('apiKey', event.target.value)} placeholder={editingConfig?.hasApiKey ? '••••••••（留空保留）' : '输入 API Key'} required={!editingConfig} autoComplete="new-password" />
            </Field>
          )}

          {form.providerType === 'ollama' && (
            <Field label="上下文窗口（词元）" required hint="窗口越大越占内存；默认 32,768，长文会自动分层处理。">
              <input className={INPUT_CLASS} type="number" min={4096} max={262144} step={1024} value={form.contextWindow} onChange={(event) => set('contextWindow', Number(event.target.value))} required />
            </Field>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="请求超时（秒）" required>
              <input className={INPUT_CLASS} type="number" min={1} max={1800} value={form.timeoutSeconds} onChange={(event) => set('timeoutSeconds', Number(event.target.value))} required />
            </Field>
            <Field label="最大并发" required hint="所有 AI 功能共同受此上限约束。">
              <input className={INPUT_CLASS} type="number" min={1} max={32} value={form.maxConcurrency} onChange={(event) => set('maxConcurrency', Number(event.target.value))} required />
            </Field>
          </div>

          <div className="flex gap-3 border-t border-gray-200 pt-6 dark:border-gray-700">
            <button type="button" onClick={onClose} disabled={isSaving} className="flex-1 rounded-xl border border-gray-300 px-4 py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700">
              取消
            </button>
            <button type="submit" disabled={isSaving} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
              {isSaving ? <Loader size={18} className="animate-spin" /> : <Save size={18} />}
              {isSaving ? '保存中...' : '保存配置'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function TestBadge({ config }: { config: ModelServiceConfig }) {
  if (config.testStatus === 'success' && config.testedRevision === config.revision) {
    return <span className="shrink-0 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">测试成功</span>;
  }
  if (config.testStatus === 'failed') {
    return <span className="shrink-0 rounded-full bg-red-100 px-2.5 py-1 text-xs font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-300">测试失败</span>;
  }
  return <span className="shrink-0 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-600 dark:bg-gray-700 dark:text-gray-300">未测试</span>;
}

function ActionButton({
  onClick,
  disabled,
  icon: Icon,
  label,
  primary = false,
  danger = false,
  spin = false,
}: {
  onClick: () => void;
  disabled: boolean;
  icon: typeof Zap;
  label: string;
  primary?: boolean;
  danger?: boolean;
  spin?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${
        primary
          ? 'bg-blue-600 text-white hover:bg-blue-700'
          : danger
            ? 'bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-300'
            : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600'
      }`}
    >
      <Icon size={14} className={spin ? 'animate-spin' : ''} />
      {label}
    </button>
  );
}

function Field({
  label,
  required = false,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-semibold text-gray-800 dark:text-gray-200">
        {label}{required && <span className="ml-1 text-red-500">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1.5 block text-xs leading-5 text-gray-500">{hint}</span>}
    </label>
  );
}

function formFromConfig(config: ModelServiceConfig, isCopy: boolean): FormState {
  return {
    name: config.name,
    providerType: config.providerType,
    model: config.model,
    baseUrl: config.baseUrl || '',
    apiKey: '',
    timeoutSeconds: Math.max(1, Math.round(config.timeoutMs / 1000)),
    maxConcurrency: config.maxConcurrency,
    contextWindow: config.contextWindow || 32768,
    ...(isCopy ? { apiKey: '' } : {}),
  };
}

function toApiInput(form: FormState): ModelServiceConfigInput {
  const common = {
    name: form.name.trim(),
    providerType: form.providerType,
    model: form.model.trim(),
    timeoutMs: Math.round(form.timeoutSeconds * 1000),
    maxConcurrency: Math.round(form.maxConcurrency),
  };
  return {
    ...common,
    providerType: form.providerType,
    baseUrl: form.baseUrl.trim(),
    contextWindow: form.providerType === 'ollama' ? Math.round(form.contextWindow) : null,
    ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
  };
}

const INPUT_CLASS = 'w-full rounded-xl border border-gray-300 bg-white px-3.5 py-2.5 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100 dark:border-gray-600 dark:bg-gray-900 dark:text-white dark:focus:ring-blue-900/40';
