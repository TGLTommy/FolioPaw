import { useState, useEffect, useCallback } from 'react';
import type { Toast as ToastInterface } from '../contexts/ToastContext';
import { useToast } from '../contexts/useToast';
import { CheckCircle, AlertCircle, Info, AlertTriangle, X } from 'lucide-react';

export function ToastContainer() {
  const { toasts, removeToast } = useToast();

  return (
    <div className="fixed top-4 right-4 z-50 space-y-3 max-w-sm">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onClose={() => removeToast(toast.id)} />
      ))}
    </div>
  );
}

interface ToastProps {
  toast: ToastInterface;
  onClose: () => void;
}

function Toast({ toast, onClose }: ToastProps) {
  const [isExiting, setIsExiting] = useState(false);

  const handleClose = useCallback(() => {
    setIsExiting(true);
    setTimeout(onClose, 300);
  }, [onClose]);

  useEffect(() => {
    if (toast.duration && toast.duration > 0) {
      const timer = setTimeout(() => {
        handleClose();
      }, toast.duration);
      return () => clearTimeout(timer);
    }
  }, [toast.duration, handleClose]);

  const getIcon = () => {
    switch (toast.type) {
      case 'success':
        return <CheckCircle size={20} className="text-green-600 dark:text-green-400" />;
      case 'error':
        return <AlertCircle size={20} className="text-red-600 dark:text-red-400" />;
      case 'warning':
        return <AlertTriangle size={20} className="text-yellow-600 dark:text-yellow-400" />;
      case 'info':
      default:
        return <Info size={20} className="text-blue-600 dark:text-blue-400" />;
    }
  };

  const getBackgroundColor = () => {
    switch (toast.type) {
      case 'success':
        return 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800';
      case 'error':
        return 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800';
      case 'warning':
        return 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800';
      case 'info':
      default:
        return 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800';
    }
  };

  const getTextColor = () => {
    switch (toast.type) {
      case 'success':
        return 'text-green-900 dark:text-green-100';
      case 'error':
        return 'text-red-900 dark:text-red-100';
      case 'warning':
        return 'text-yellow-900 dark:text-yellow-100';
      case 'info':
      default:
        return 'text-blue-900 dark:text-blue-100';
    }
  };

  return (
    <div
      className={`
        transform transition-all duration-300 ease-out
        ${
          isExiting
            ? 'translate-x-full opacity-0'
            : 'translate-x-0 opacity-100'
        }
      `}
    >
      <div
        className={`
          flex items-start gap-3 px-4 py-3 rounded-lg border shadow-lg
          ${getBackgroundColor()}
          ${getTextColor()}
          backdrop-blur-sm
        `}
      >
        <div className="flex-shrink-0 mt-0.5">{getIcon()}</div>
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm break-words">{toast.message}</p>
        </div>
        <button
          onClick={handleClose}
          className="flex-shrink-0 text-current opacity-60 hover:opacity-100 transition-opacity p-0.5"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
