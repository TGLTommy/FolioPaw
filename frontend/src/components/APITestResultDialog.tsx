import { CheckCircle, AlertCircle, Clock, X } from 'lucide-react';

interface APITestResult {
  success: boolean;
  provider: string;
  model: string;
  message: string;
  responseTime?: number;
  statusCode?: number;
  error?: string;
  details?: Record<string, unknown>;
}

interface APITestResultDialogProps {
  isOpen: boolean;
  result: APITestResult | null;
  isLoading: boolean;
  onClose: () => void;
}

export default function APITestResultDialog({
  isOpen,
  result,
  isLoading,
  onClose,
}: APITestResultDialogProps) {
  if (!isOpen || !result) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40 transition-opacity duration-200"
        onClick={onClose}
        aria-label="关闭对话框"
      />

      {/* Dialog */}
      <div className="fixed inset-0 flex items-center justify-center z-50 p-4">
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl max-w-md w-full transform transition-all duration-200">
          {/* Header */}
          <div
            className={`flex items-center justify-between p-6 border-b ${
              result.success
                ? 'border-green-200 dark:border-green-900/30 bg-green-50 dark:bg-green-900/10'
                : 'border-red-200 dark:border-red-900/30 bg-red-50 dark:bg-red-900/10'
            }`}
          >
            <div className="flex items-center gap-3">
              <div
                className={`flex-shrink-0 flex items-center justify-center w-12 h-12 rounded-full ${
                  result.success
                    ? 'bg-green-100 dark:bg-green-900/30'
                    : 'bg-red-100 dark:bg-red-900/30'
                }`}
              >
                {isLoading ? (
                  <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                ) : result.success ? (
                  <CheckCircle className="w-6 h-6 text-green-600 dark:text-green-400" />
                ) : (
                  <AlertCircle className="w-6 h-6 text-red-600 dark:text-red-400" />
                )}
              </div>
              <div>
                <h2 className="text-lg font-bold text-gray-900 dark:text-white">
                  {isLoading ? '测试中...' : result.success ? '连接成功' : '连接失败'}
                </h2>
              </div>
            </div>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition"
            >
              <X size={20} />
            </button>
          </div>

          {/* Content */}
          <div className="p-6 space-y-4">
            {/* Message */}
            <div>
              <p
                className={`text-sm font-medium ${
                  result.success
                    ? 'text-green-700 dark:text-green-300'
                    : 'text-red-700 dark:text-red-300'
                }`}
              >
                {result.message}
              </p>
            </div>

            {/* Details */}
            <div className="space-y-2 border-t border-gray-200 dark:border-gray-700 pt-4">
              {/* Provider */}
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-600 dark:text-gray-400">API 提供商</span>
                <span className="text-sm font-semibold text-gray-900 dark:text-white">
                  {result.provider}
                </span>
              </div>

              {/* Model */}
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-600 dark:text-gray-400">模型</span>
                <span className="text-sm font-semibold text-gray-900 dark:text-white">
                  {result.model}
                </span>
              </div>

              {/* Response Time */}
              {result.responseTime !== undefined && (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Clock size={14} className="text-blue-600 dark:text-blue-400" />
                    <span className="text-sm text-gray-600 dark:text-gray-400">响应时间</span>
                  </div>
                  <span className="text-sm font-semibold text-gray-900 dark:text-white">
                    {result.responseTime} 毫秒
                  </span>
                </div>
              )}

              {/* Status Code */}
              {result.statusCode && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-600 dark:text-gray-400">HTTP 状态码</span>
                  <span className="text-sm font-semibold text-gray-900 dark:text-white">
                    {result.statusCode}
                  </span>
                </div>
              )}

              {/* Error Details */}
              {result.error && (
                <div className="mt-3 p-3 bg-red-100 dark:bg-red-900/20 border border-red-300 dark:border-red-700/50 rounded-lg">
                  <p className="text-xs font-medium text-red-700 dark:text-red-300 mb-1">
                    错误详情：
                  </p>
                  <p className="text-xs text-red-600 dark:text-red-400 break-words">
                    {result.error}
                  </p>
                </div>
              )}

              {/* Additional Details */}
              {result.details && (
                <div className="mt-3 p-3 bg-blue-100 dark:bg-blue-900/20 border border-blue-300 dark:border-blue-700/50 rounded-lg">
                  <p className="text-xs font-medium text-blue-700 dark:text-blue-300 mb-2">
                    详细信息：
                  </p>
                  <div className="space-y-1">
                    {Object.entries(result.details).map(([key, value]) => (
                      <div key={key} className="flex justify-between text-xs">
                        <span className="text-blue-600 dark:text-blue-400">{key}:</span>
                        <span className="text-blue-700 dark:text-blue-300 break-all text-right max-w-xs">
                          {typeof value === 'string'
                            ? value.length > 50
                              ? value.substring(0, 50) + '...'
                              : value
                            : JSON.stringify(value)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="flex gap-3 p-6 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50 rounded-b-2xl">
            <button
              onClick={onClose}
              disabled={isLoading}
              className="flex-1 px-4 py-2.5 text-white bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 rounded-lg transition-all font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
            >
              关闭
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
