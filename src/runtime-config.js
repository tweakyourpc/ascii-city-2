import deployment from '../ascii-city.config.js';

/** Normalize an optional HTTP(S) service base without accepting other schemes. */
export function serviceBase(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  let url;
  try { url = new URL(value.trim()); } catch { return ''; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  if (url.username || url.password) return '';
  return url.href.replace(/\/$/, '');
}

/** Optional Worker owned by the person deploying this fork. */
export const WORKER_URL = serviceBase(deployment?.workerUrl);
