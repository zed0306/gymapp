// Общий контекст для модулей-фич (js/features/*). Заполняется в app.js при запуске.
//
// Модуль — объект с необязательными полями:
//   id        — строка
//   keys      — ключи хранилища, которые он использует (CloudStorage, ≤ 4096 символов на ключ)
//   screens   — { name: (params) => html }   экраны, открываются ctx.push(name, params)
//   sheets    — { name: (params) => html }   нижние шторки, ctx.openSheet(name, params)
//   actions   — { name: (dataset, el, event) => void }   клики по [data-act="name"]
//   binds     — { name: (value, dataset, el) => void }    ввод в input[data-bind="name"]
//   slots     — { slotName: () => html }     вставки в чужие экраны (см. SLOTS в app.js)
//   foods     — () => [{ id, name, k, p, f, c, unit?, unitName? }]  доп. продукты для дневника
//   on        — { event: (payload) => void } события: boot, workout, water, food, weight, profile, …
//   mount     — (root) => void               после каждой отрисовки (графики, камера и т. п.)
//   unmount   — () => void                   перед каждой отрисовкой (остановить камеру и т. п.)

export const ctx = {};

let features = [];

export function setFeatures(list) {
  features = list;
}

export function getFeatures() {
  return features;
}

export function findIn(field, name) {
  for (const f of features) {
    const fn = f[field]?.[name];
    if (fn) return fn;
  }
  return null;
}

export function slot(name) {
  return features.map((f) => {
    try {
      return f.slots?.[name]?.() || '';
    } catch (e) {
      console.error(`slot ${name} in ${f.id}`, e);
      return '';
    }
  }).join('');
}

export function emit(event, payload) {
  for (const f of features) {
    try {
      f.on?.[event]?.(payload);
    } catch (e) {
      console.error(`event ${event} in ${f.id}`, e);
    }
  }
}
