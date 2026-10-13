# Как запустить бота и сервер GymApp на VPS

Мини-апп живёт на GitHub Pages и работает сам по себе. А вот боту (ответы на /start,
напоминания, админка) и серверу для **челленджей и статистики** нужен компьютер, который
включён 24/7, — арендованный сервер (VPS). Эта инструкция — для тех, кто делает это впервые.
Займёт минут 20.

```
Telegram ──► бот (python bot.py) ◄── база SQLite в ./data
               ▲
мини-апп ──► https://<PUBLIC_HOST>/api/… ──► Caddy (HTTPS) ──► бот:8080
```

## Что понадобится

- **Токен бота** — в @BotFather: `/mybots` → твой бот → *API Token*.
- **Свой Telegram ID** — напиши @userinfobot, он ответит числом. Это нужно для админки.
- **VPS** — сервер с Ubuntu 22.04 или 24.04. Хватит самого простого тарифа: 1 ядро,
  **1 ГБ памяти**, 10 ГБ диска, публичный IPv4-адрес. Подойдёт любой провайдер
  (Timeweb Cloud, Selectel, Aeza, Hetzner, DigitalOcean и т. д.).

> Бот должен быть запущен **в одном месте**. Если он уже работает у тебя на компьютере — останови
> его там, иначе Telegram будет ругаться `Conflict: terminated by other getUpdates request`.

## Шаг 1. Арендуй сервер

При заказе выбери образ **Ubuntu 22.04** или **24.04**. После создания провайдер покажет
**IP-адрес** (например, `203.0.113.5`) и пароль root (или попросит SSH-ключ).

Если у провайдера есть «Firewall / Брандмауэр» — открой входящие порты **22, 80 и 443**.

## Шаг 2. Подключись к серверу

На Windows открой «Терминал» (PowerShell), на macOS/Linux — «Терминал»:

```bash
ssh root@203.0.113.5
```

На вопрос `Are you sure you want to continue connecting` ответь `yes`, затем введи пароль
(символы при вводе не видны — это нормально).

## Шаг 3. Поставь Docker

```bash
curl -fsSL https://get.docker.com | sh
docker compose version
```

Вторая команда должна показать версию, например `Docker Compose version v2.29.1`.

## Шаг 4. Скачай проект

```bash
apt-get install -y git
git clone https://github.com/zed0306/gymapp.git
cd gymapp
```

## Шаг 5. Впиши настройки

```bash
cp bot/.env.example bot/.env
chmod 600 bot/.env        # в файле будет токен — читать его может только root
ln -s bot/.env .env       # ссылка: из неё Caddy возьмёт адрес сервера (и больше ничего)
nano bot/.env
```

Поменяй четыре строки (остальные можно не трогать):

| Строка | Что вписать |
|---|---|
| `BOT_TOKEN=` | токен от @BotFather |
| `ADMIN_IDS=` | свой Telegram ID (несколько — через запятую) |
| `PUBLIC_HOST=` | IP сервера **через дефисы** + `.sslip.io`, например `203-0-113-5.sslip.io` |
| `PUBLIC_URL=` | `https://` + то же самое, например `https://203-0-113-5.sslip.io` |

Сохрани: `Ctrl+O`, `Enter`, выйди: `Ctrl+X`.

Зачем ссылка `.env`: Caddy (HTTPS) нужен только адрес сервера. Docker Compose подставляет его
из файла `.env` рядом с `docker-compose.yml`, а ссылка ведёт в тот же `bot/.env` — править
по-прежнему один файл, а токен бота в контейнер Caddy не попадает. Если забыть ссылку,
`docker compose up` остановится с подсказкой `впиши PUBLIC_HOST в bot/.env и сделай ссылку`.

**Что за sslip.io?** Это бесплатный сервис: адрес `203-0-113-5.sslip.io` всегда указывает на IP
`203.0.113.5`. Покупать домен не нужно, а Caddy (веб-сервер в комплекте) сам получит для него
бесплатный HTTPS-сертификат Let's Encrypt. HTTPS обязателен: мини-апп открыт по https и не
сможет обращаться к серверу по http. Если у тебя есть свой домен — впиши его вместо sslip.io
(A-запись домена должна указывать на IP сервера).

## Шаг 6. Запусти

```bash
docker compose up -d
```

Первый запуск займёт 1–2 минуты: Docker скачает Python и Caddy и соберёт бота.
Посмотреть, что всё поднялось:

```bash
docker compose ps
docker compose logs -f bot      # выйти — Ctrl+C
```

В логах бота должны быть строки `API слушает 0.0.0.0:8080` и `Start polling`.

## Шаг 7. Проверь

1. Открой в браузере `https://203-0-113-5.sslip.io/api/health` (со своим адресом).
   Должно показать `{"ok":true}`. Если браузер ругается на сертификат — подожди минуту,
   Caddy ещё получает его (`docker compose logs caddy`).
2. Напиши боту `/start` — он ответит приветствием.
3. Нажми «Открыть GymApp» в сообщении бота или кнопку «Открыть» слева от поля ввода. Бот сам
   передаёт мини-аппу адрес сервера (`?api=…`), поэтому челленджи сразу заработают.
4. Админу: `/admin` → «Статистика» — там появится раздел «Мини-апп».

## Шаг 8. Пропиши адрес сервера в BotFather (обязательно)

Кнопки в сообщениях и кнопку меню бот настраивает сам. Но мини-апп открывается ещё и кнопкой
«Открыть» в профиле бота и по ссылкам вида `t.me/<бот>/app` — их адрес задаётся в @BotFather и
про сервер ничего не знает. Без адреса сервера мини-апп в таком запуске может взять адрес,
запомненный раньше (в том числе подсунутый чужой ссылкой), и отправить туда подпись Telegram.
Поэтому сделай **одно из двух**:

- в @BotFather: `/mybots` → бот → *Bot Settings* → *Configure Mini App* → адрес
  **вместе с сервером**: `https://zed0306.github.io/gymapp/?api=https://203-0-113-5.sslip.io`;
- или впиши адрес сервера в `API_URL` в `js/config.js` мини-аппа и опубликуй сайт — тогда
  мини-апп найдёт сервер при любом способе запуска.

## Обновление

Когда в репозитории появились изменения:

```bash
cd ~/gymapp
git pull && docker compose up -d --build
```

## Полезные команды

```bash
docker compose logs -f bot        # логи бота
docker compose restart bot        # перезапустить бота
docker compose down               # остановить всё (данные сохранятся)
docker compose up -d              # запустить снова
```

**Резервная копия.** Все данные — в одном файле `data/gymapp.db`. Сначала на сервере сделай
целую копию (так она не испортится, даже если бот в этот момент пишет в базу):

```bash
cd ~/gymapp
docker compose exec bot python -c "import sqlite3; sqlite3.connect('/data/gymapp.db').backup(sqlite3.connect('/data/backup.db'))"
```

Потом на своём компьютере забери её в домашнюю папку:

```bash
scp root@203.0.113.5:gymapp/data/backup.db ~/gymapp-backup.db
```

> **Не клади копию в папку проекта `gymapp`.** В базе личные данные пользователей (имена,
> Telegram ID, вес), а папка проекта — это git-репозиторий, который публикуется на GitHub Pages.
> Одно случайное `git add` — и база окажется в открытом доступе. По той же причине не коммить
> папку `data/` и файлы `.env`.

## Если что-то не работает

| Симптом | Что проверить |
|---|---|
| `/api/health` не открывается | Открыты ли порты 80 и 443 у провайдера; включён ли `ufw` (`ufw allow 80,443/tcp`); верный ли `PUBLIC_HOST`; `docker compose logs caddy` |
| Бот не отвечает | `docker compose logs bot`: неверный `BOT_TOKEN` или бот запущен ещё где-то (`Conflict`) |
| В мини-аппе «Сервер не подключён» | Задан ли `PUBLIC_URL`; открывай мини-апп кнопкой из бота — так он узнает адрес |
| Ошибка «Открой приложение из Telegram» | Запросы без подписи Telegram сервер не принимает — открывай мини-апп внутри Telegram |
| Мини-апп на другом сайте | Добавь его адрес в `ALLOWED_ORIGINS` (через запятую) и перезапусти: `docker compose up -d` |

После любого изменения `bot/.env` выполни `docker compose up -d` — контейнеры перезапустятся
с новыми настройками.

## Вариант без Docker

Если не хочешь Docker — бот запускается как обычная программа, а HTTPS даёт Caddy из apt.

Код и Python остаются за root — бот может только читать их, поэтому даже при взломе процесса
переписать свой код не сможет. Писать он может только в папку с базой.

```bash
# 1. Python и код (владелец — root)
apt-get update && apt-get install -y python3-venv git
git clone https://github.com/zed0306/gymapp.git /opt/gymapp
python3 -m venv /opt/gymapp/.venv
/opt/gymapp/.venv/bin/pip install -r /opt/gymapp/bot/requirements.txt

# 2. Отдельный пользователь для бота и настройки: токен читают только root и бот
useradd --system --no-create-home --shell /usr/sbin/nologin gymapp
cp /opt/gymapp/bot/.env.example /opt/gymapp/bot/.env
chown root:gymapp /opt/gymapp/bot/.env && chmod 640 /opt/gymapp/bot/.env
nano /opt/gymapp/bot/.env        # как в шаге 5, плюс API_HOST=127.0.0.1
```

Служба, чтобы бот работал всегда и поднимался после перезагрузки, — файл
`/etc/systemd/system/gymapp.service`. База будет в `/var/lib/gymapp` — systemd сам создаст эту
папку и отдаст её боту, а всё остальное для бота — только для чтения:

```ini
[Unit]
Description=GymApp bot
After=network-online.target
Wants=network-online.target

[Service]
User=gymapp
Group=gymapp
WorkingDirectory=/opt/gymapp/bot
ExecStart=/opt/gymapp/.venv/bin/python bot.py
StateDirectory=gymapp
Environment=DB_PATH=/var/lib/gymapp/gymapp.db
Environment=PYTHONDONTWRITEBYTECODE=1
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now gymapp
journalctl -u gymapp -f           # логи
```

HTTPS через Caddy (команды с caddyserver.com/docs/install):

```bash
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
```

Замени содержимое `/etc/caddy/Caddyfile` (со своим адресом) и перезагрузи Caddy:

```
203-0-113-5.sslip.io {
	reverse_proxy 127.0.0.1:8080
}
```

```bash
systemctl reload caddy
```

Обновление (от root):

```bash
cd /opt/gymapp && git pull && .venv/bin/pip install -r bot/requirements.txt && systemctl restart gymapp
```

Резервная копия — как выше, только путь другой: на сервере
`sudo -u gymapp /opt/gymapp/.venv/bin/python -c "import sqlite3; sqlite3.connect('/var/lib/gymapp/gymapp.db').backup(sqlite3.connect('/var/lib/gymapp/backup.db'))"`,
потом `scp root@203.0.113.5:/var/lib/gymapp/backup.db ~/gymapp-backup.db` — тоже не в папку проекта.

## Для разработчика

- Тесты сервера: `cd bot && python -m unittest discover -s tests -v` (Telegram не нужен).
- Локально: `DEV=1` разрешает запросы с `http://127.0.0.1:8080` и `http://localhost:8080`.
  Если мини-апп раздаётся на 8080, запусти API на другом порту: `API_PORT=8081`, и открой
  `http://127.0.0.1:8080/?api=http://127.0.0.1:8081`. Учти: вне Telegram у мини-аппа нет подписи
  `initData`, поэтому сервер ответит 401 — по-настоящему проверяется только внутри Telegram.
- Контракт API — `docs/ARCHITECTURE.md`, раздел «API сервера».
