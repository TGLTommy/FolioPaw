/**
 * 开发环境默认走相对路径 /api，由 Vite 代理到本机后端，局域网内其他设备打开页面时请求仍会落到开发机上。
 * 若需直连后端，可在 frontend/.env 设置 VITE_API_URL=http://<本机局域网IP>:17891/api
 * 生产环境默认使用同源 /api，避免把已部署前端指向访问者本机 localhost。
 */
export const API_BASE_URL =
  import.meta.env.VITE_API_URL ||
  '/api';

/** 用于拼接 /uploads 等静态路径；开发 + 代理时为 ''，走当前页面同源 */
export const BACKEND_ORIGIN = API_BASE_URL.replace(/\/api\/?$/, '');
