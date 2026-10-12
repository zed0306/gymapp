// Хранилище: Telegram CloudStorage (данные привязаны к пользователю и доступны
// с любого устройства) + localStorage как быстрый кэш и запасной вариант вне Telegram.

const tg = window.Telegram?.WebApp;
const cloud = tg && tg.isVersionAtLeast?.('6.9') ? tg.CloudStorage : null;
const uid = tg?.initDataUnsafe?.user?.id || 'guest';
// zed0306.github.io — общий origin для всех мини-аппов автора, поэтому префикс
const PREFIX = `gymapp:${uid}:`;

export const KEYS = ['profile', 'water', 'food', 'foodHist', 'weights', 'lifts', 'hist', 'session'];

// Модули-фичи добавляют свои ключи до load()
export function registerKeys(keys) {
  for (const k of keys) if (!KEYS.includes(k)) KEYS.push(k);
}

export const MAX_VALUE = 4096;

const cache = {};

function localGet(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function localSet(key, value) {
  try {
    if (value === null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* приватный режим и т. п. */
  }
}

function cloudGetAll(keys) {
  return new Promise((resolve) => {
    if (!cloud) return resolve(null);
    const timer = setTimeout(() => resolve(null), 3000);
    try {
      cloud.getItems(keys, (err, values) => {
        clearTimeout(timer);
        resolve(err ? null : values);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

export async function load() {
  const remote = await cloudGetAll(KEYS);
  for (const key of KEYS) {
    let value = null;
    if (remote && remote[key]) {
      try {
        value = JSON.parse(remote[key]);
      } catch {
        value = null;
      }
    }
    if (value === null) {
      value = localGet(key);
      // В облаке пусто, а локально есть — заливаем
      if (value !== null && remote) push(key, value);
    } else {
      localSet(key, value);
    }
    cache[key] = value;
  }
  return { ...cache };
}

function push(key, value) {
  if (!cloud) return;
  try {
    if (value === null) cloud.removeItem(key);
    else {
      const raw = JSON.stringify(value);
      // лимит CloudStorage — 4096 символов на значение
      if (raw.length <= MAX_VALUE) cloud.setItem(key, raw);
      else console.warn('CloudStorage: значение слишком большое', key, raw.length);
    }
  } catch (e) {
    console.warn('CloudStorage error', e);
  }
}

export function get(key) {
  return cache[key] ?? null;
}

export function set(key, value) {
  cache[key] = value;
  localSet(key, value);
  push(key, value);
}

export function clearAll() {
  for (const key of KEYS) set(key, null);
}

export const isCloud = () => !!cloud;

// Размер значения в символах (лимит CloudStorage — 4096 на ключ)
export const sizeOf = (value) => JSON.stringify(value ?? null).length;
