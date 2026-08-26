type ErrorLike = {
  message?: unknown;
  name?: unknown;
  code?: unknown;
  response?: {
    data?: {
      error?: unknown;
    };
  };
};

const isErrorLike = (value: unknown): value is ErrorLike =>
  typeof value === 'object' && value !== null;

export const getErrorMessage = (error: unknown, fallback = '操作失败'): string => {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (isErrorLike(error) && typeof error.message === 'string' && error.message) {
    return error.message;
  }

  return fallback;
};

export const getApiErrorMessage = (error: unknown, fallback = '操作失败'): string => {
  if (
    isErrorLike(error) &&
    typeof error.response?.data?.error === 'string' &&
    error.response.data.error
  ) {
    return error.response.data.error;
  }

  return getErrorMessage(error, fallback);
};

export const getCancellationInfo = (error: unknown): {
  code?: string;
  isCancelled: boolean;
  name?: string;
} => {
  const name = isErrorLike(error) && typeof error.name === 'string' ? error.name : undefined;
  const code = isErrorLike(error) && typeof error.code === 'string' ? error.code : undefined;

  return {
    code,
    name,
    isCancelled: (
      name === 'AbortError' ||
      name === 'CanceledError' ||
      code === 'ERR_CANCELED' ||
      code === 'ECONNABORTED'
    ),
  };
};
