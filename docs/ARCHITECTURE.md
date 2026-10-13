# Архитектура GymApp

Мини-апп — статический сайт (GitHub Pages, ветка `main`), без сборки: ES-модули в браузере.
Бот и сервер для челленджей — `bot/` (Python, aiogram 3 + aiohttp), запускается на любом VPS.

## Мини-апп

```
index.html          точка входа, подключает css/*.css и js/app.js
js/app.js           ядро: онбординг, вкладки, тренировки, питание, вода, профиль, навигация
js/core.js          контекст ctx и реестр модулей (слоты, события)
js/features/*.js    модули-фичи: каждый — отдельный файл + css/<id>.css
js/calc.js          формулы (BMR, КБЖУ, вода, ИМТ)
js/program.js       генератор программы тренировок
js/storage.js       Telegram CloudStorage + localStorage
js/charts.js        SVG-графики: waterChart, lineChart, weightChart
js/ui.js            иконки icon(name), esc, fmt, plural, ring, meter
js/data/*.js        тренажёры, упражнения, продукты
```

### Отрисовка

Состояние — объект `S` (данные пользователя, ключ = ключ хранилища). Любое действие меняет
`S` и вызывает `ctx.render()`, которое целиком пересобирает `#app.innerHTML` из строк HTML.
Поэтому: обработчики событий не вешаются на элементы — только делегирование через
`data-act` (клики) и `data-bind` (ввод) и `data-file` (выбор файлов). Ввод в поля не должен
вызывать `render()` (пропадёт фокус) — обновляй состояние и, если нужно, точечно меняй DOM.

### Контракт модуля (`js/features/<id>.js`, `export default {…}`)

| Поле | Тип | Назначение |
|---|---|---|
| `id` | string | идентификатор |
| `keys` | string[] | ключи хранилища модуля. Значение ≤ **4096 символов JSON** (лимит CloudStorage). Храни компактно (массивы вместо объектов), обрезай историю. Если значение больше — оно сохранится только локально. |
| `screens` | `{name: (params) => html}` | полноэкранные экраны, открываются `ctx.push(name, params)`. Обёртка: `<div class="page no-tabs">${ctx.backHeader('Заголовок')}…</div>` |
| `sheets` | `{name: (params) => html}` | нижние шторки, `ctx.openSheet(name, params)` |
| `actions` | `{name: (dataset, el, event) => void}` | клики по `[data-act="name"]`; `dataset` — data-атрибуты элемента |
| `binds` | `{name: (value, dataset, el) => void}` | ввод в `input/textarea/select[data-bind="name"]`; для `input[type=file][data-file="name"]` первым аргументом приходит `FileList` |
| `slots` | `{slot: () => html}` | вставки в экраны ядра (см. ниже) |
| `foods` | `() => Food[]` | доп. продукты для поиска в дневнике: `{id, name, k, p, f, c, unit?, unitName?}` на 100 г |
| `on` | `{event: (payload) => void}` | подписки на события |
| `mount` | `(root) => void` | после каждой отрисовки (графики, камера, object URL) |
| `unmount` | `() => void` | перед каждой отрисовкой (остановить камеру, отозвать URL) |
| `back` | `() => boolean` | системная «Назад»: вернуть `true`, если модуль сам обработал нажатие (закрыл своё окно) |
| `wantsBack` | `() => boolean` | показать системную «Назад», даже если нет экрана/шторки (открыто окно модуля) |

Имена `actions`, `binds`, `screens`, `sheets` — глобальные: начинай их с префикса модуля
(`ach…`, `ch…`, `ms…`, `ph…`, `bc…`).

### Слоты

| Слот | Где | Что вернуть |
|---|---|---|
| `home.top` | главная, под карточкой тренировки | карточка `.card` с `margin-top:12px` или '' |
| `home.afterWeek` | главная, под «Этой неделей» | то же |
| `train.afterProgram` | вкладка «Тренировки», под списком дней | то же |
| `food.addTop` | экран «Добавить еду», под поиском | кнопка-карточка |
| `profile.links` | профиль, секция «Прогресс» | `<button class="list-item" data-act="push" data-name="<screen>">…</button>` (см. renderProfile) |
| `done.extra` | шторка «Тренировка завершена» | блок или '' |
| `overlay` | поверх всего (после шторок) | модалка/конфетти или '' |

### События (`on`)

| Событие | Когда | payload |
|---|---|---|
| `boot` | после загрузки и первой отрисовки | `{startParam}` (`ch_XXXXXX` и т. п.) |
| `workout` | тренировка завершена | `{date, title, minutes, volume, setsDone, prs: string[], lifts}` |
| `water` | добавлена вода | `{ml, total, norm}` |
| `food` | добавлена еда | `{item}` |
| `weight` | записан вес | `{kg}` |
| `profile` | сохранён профиль (после анкеты — с `first: true`) | `{profile, first?}` |
| `reset` | пользователь сбросил данные | — |
| свои | `ctx.emit('measure')`, `ctx.emit('photo', {count})` и т. п. | |

### ctx

```
S()                 текущее состояние (S.profile, S.hist, S.lifts, S.water, S.food, S.weights, ключи модулей…)
save(key, value)    сохранить (кэш + localStorage + CloudStorage)
profile(), program(), recompute()
render(), push(name, params), replace(name, params) — заменить текущий экран, back(), openSheet(name, params),
  closeSheet(), current(), sheet(), tab(), goTab(tab)
  (кнопка data-act="push" data-name="x" data-foo="1" откроет экран x с params {foo: '1'})
toast(text), confirm(text) → Promise<bool>, haptic.tap/impact/ok/warn()
backHeader(title, sub), stepper(bind, value, unit, step), icon(name, cls), esc, fmt(n, d), plural(n, one, few, many)
ring({value,max,size,stroke,color,track,center}), meter(value, max, color), lineChart(el, [{label,value}], {unit,decimals,label})
dkey(date) 'YYYY-MM-DD', parseKey, addDays, isoWd (1=Пн), shortDate('YYYY-MM-DD') 'D.MM', dayMonth, WD, WD_FULL, MONTHS, pad2
tg, tgOk(version), tgUser, inTelegram, botUsername(), openLink(url), openTelegramLink(url)
addFoodItem({name, grams, k, p, f, c}), findFood(id), waterToday(), isTrainingDay()
emit(event, payload), slot(name)
api(path, {method, body, timeout}) → JSON. Ошибки: err.code 'no-api' (сервер не настроен), 'timeout' (нет ответа
  за 15 с), 'network' (нет связи); err.status — HTTP-код. apiBase() → '' если нет сервера.
  Адрес: CONFIG.API_URL, иначе ?api=… из ссылки бота (только при запуске из Telegram), иначе сохранённый.
startParam(), sync() — отправить сводку на сервер
```

Структуры данных ядра:
- `S.hist`: `[[date, title, minutes, volumeKg, setsDone], …]` — последние 60 тренировок
- `S.lifts`: `{exerciseId: {w, r: [reps…], d: date, fails, best}}` — `best` — лучший рабочий вес
- `S.water`: `{date: [[ml, minuteOfDay], …]}` — последние 14 дней
- `S.weights`: `[[date, kg], …]`, `S.foodHist`: `{date: [k, p, f, c]}`
- `S.profile`: `{sex 'm'|'f', age, height, weight, goal 'lose'|'maintain'|'gain', targetWeight, level 'beginner'|'intermediate'|'advanced', days [1..7], equipment, limits}`

### Правила интерфейса

- Тексты по-русски, на «ты», коротко. Без обычных эмодзи — только иконки `ctx.icon(name)`:
  home dumbbell food drop user right left check plus minus x play clock flame target info trash
  edit swap bell trophy scale calendar zap body timer chart refresh spark glass bottle male female
  down up balance sofa walk hammer alert shield link search undo moon heart list settings camera
  barcode ruler image medal users flag crown share lock star upload compare keyboard bolt
- Готовые классы (css/style.css): `page`, `card`, `card-link`, `list`, `list-item`, `btn` (+ `ghost`,
  `outline`, `danger`, `sm`, `block`, `water`), `icon-btn`, `icon-box` (+ `accent`, `water`),
  `badge` (+ `accent`, `water`), `chips`/`chip`(+`on`), `field`, `input`, `stepper`, `section-title`,
  `h1 h2 h3 sub muted small tiny num`, `notice`, `stat`, `grid-2`, `grid-3`, `row`, `grow`,
  `bottom-bar > .inner`, `empty`, `kv`, `sheet`, `meter`.
- Цвета только через CSS-переменные: `--bg --surface --surface-2 --surface-3 --line --text --text-2
  --muted --accent --accent-ink --accent-text --accent-soft --water --protein --fat --carbs --danger
  --warn --ok`. Обе темы (тёмная и светлая) должны выглядеть нормально.
- Ширина экрана 320–560 px, отступы 16 px, без горизонтальной прокрутки.
- Тактильный отклик: `ctx.haptic.tap()` на переключениях, `ok()` на успехе.

## API сервера (бот, `bot/api.py`)

База — `ctx.apiBase()` (например `https://1-2-3-4.sslip.io`). Все запросы — JSON, заголовок
`X-Init-Data: Telegram.WebApp.initData`. Сервер проверяет подпись initData (HMAC-SHA256,
ключ = HMAC_SHA256("WebAppData", BOT_TOKEN)), `auth_date` не старше 7 дней. Ответ с ошибкой:
`{"error": "текст для пользователя"}` и код 4xx. CORS: `ALLOWED_ORIGINS` (по умолчанию
`https://zed0306.github.io`), заголовки `Content-Type, X-Init-Data`, методы GET/POST/OPTIONS.

| Метод | Путь | Тело / ответ |
|---|---|---|
| GET | `/api/health` | без авторизации → `{ok: true}` |
| POST | `/api/sync` | `{profile: {sex, age, height, weight, goal, level, days}, stats: {workouts, volume, prs, streak, bestStreak, weekStreak}, lifts: {exerciseId: bestKg}, hist: [[date, volumeKg], …]}` → `{ok: true}` |
| GET | `/api/challenges` | → `{challenges: [Challenge]}` — мои (активные сначала, потом 10 последних завершённых) |
| POST | `/api/challenges` | `{type, exercise?, target, days?}` → `{challenge}` |
| GET | `/api/challenges/<code>` | → `{challenge}` (видно любому авторизованному — чтобы решить, вступать ли) |
| POST | `/api/challenges/<code>/join` | → `{challenge}` |
| POST | `/api/challenges/<code>/leave` | → `{ok: true}` |
| GET | `/api/admin/stats` | только ADMIN_IDS → `{users_total, users_new_7d, active_7d, synced_users, workouts_total, challenges_active, goals: {lose, maintain, gain}, levels: {beginner, intermediate, advanced}, sexes: {m, f}, new_by_day: [[date, n] × 30]}` |

Типы челленджей:
- `lift` — «кто первый пожмёт N кг»: `exercise` из `LIFT_EXERCISES`, `target` 10–500 кг, `days` 0–180 (0 = без срока). Прогресс — лучший вес в упражнении из последнего `/api/sync`.
- `workouts` — «N тренировок за D дней»: `target` 1–100, `days` 1–90. Прогресс — число тренировок (даты из `hist`) с даты старта по дату окончания включительно.
- `volume` — «N кг объёма за D дней»: `target` 1000–1000000, `days` 1–90. Прогресс — сумма объёма из `hist` в окне.

`LIFT_EXERCISES` (id → название): `bb_bench` Жим штанги лёжа, `bb_squat` Приседания со штангой,
`deadlift` Становая тяга, `bb_ohp` Жим штанги стоя, `db_bench` Жим гантелей лёжа (вес одной гантели),
`leg_press` Жим ногами.

Challenge:
```
{ code: 'K7M2QX', type, exercise, exercise_name, target, days, title,
  created_by: userId, created_at: ISO, starts_on: 'YYYY-MM-DD', ends_on: 'YYYY-MM-DD'|null,
  status: 'active'|'finished', finished_at: ISO|null, winner: {id, name}|null,
  participants: [{id, name, username, progress, reached_at: ISO|null, is_me}],  // по убыванию прогресса
  my_progress, invite_link: 'https://t.me/<bot>?start=ch_<code>' }
```
Победитель — первый, у кого `progress ≥ target` (по `reached_at`). Если срок вышел и цели никто
не достиг — побеждает лидер (при нуле — без победителя). До 50 участников, до 10 активных
челленджей на человека. Сервер пишет участникам в бот: «X принял вызов», «X первым пожал 100 кг!».

Приглашение: `https://t.me/<bot>?start=ch_<code>` → бот отвечает карточкой челленджа с кнопкой
мини-аппа на адрес `<WEBAPP_URL>?ch=<code>&api=<PUBLIC_URL>` → мини-апп видит `startParam() === 'ch_<code>'`.
