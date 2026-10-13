"""GymApp bot: открывает мини-апп, напоминает про воду и тренировки, челленджи, админ-панель.

Вместе с ботом (long polling) в том же процессе работает HTTP API для мини-аппа (api.py)
на API_HOST:API_PORT (по умолчанию 0.0.0.0:8080).

Запуск:  python bot.py   (переменные окружения — см. .env.example, деплой — DEPLOY.md)
"""

import asyncio
import contextlib
import csv
import html
import io
import logging
import os
import re
import sqlite3
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from aiogram import Bot, Dispatcher, F
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.exceptions import TelegramBadRequest, TelegramForbiddenError, TelegramRetryAfter
from aiogram.filters import Command, CommandObject, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import (
    BotCommand,
    BotCommandScopeChat,
    BufferedInputFile,
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    MenuButtonWebApp,
    Message,
    WebAppInfo,
)
from aiohttp import web

import api

BASE = Path(__file__).parent


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env(BASE / ".env")
BOT_TOKEN = os.environ.get("BOT_TOKEN", "").strip()
# «or» — пустое значение в .env (ИМЯ=) тоже значит «по умолчанию»
WEBAPP_URL = os.environ.get("WEBAPP_URL", "").strip() or "https://zed0306.github.io/gymapp/"
DB_PATH = os.environ.get("DB_PATH", "").strip() or str(BASE / "gymapp.db")
ADMIN_IDS = {int(x) for x in re.findall(r"\d+", os.environ.get("ADMIN_IDS", ""))}
# Адрес сервера бота снаружи (https://1-2-3-4.sslip.io) — передаётся мини-аппу как ?api=…
PUBLIC_HOST = os.environ.get("PUBLIC_HOST", "").strip().strip("/")
PUBLIC_URL = os.environ.get("PUBLIC_URL", "").strip().rstrip("/") or (f"https://{PUBLIC_HOST}" if PUBLIC_HOST else "")
API_HOST = os.environ.get("API_HOST", "").strip() or "0.0.0.0"
API_PORT = int(os.environ.get("API_PORT", "").strip() or 8080)
DEV = os.environ.get("DEV", "").strip().lower() in ("1", "true", "yes")
ALLOWED_ORIGINS = api.parse_origins(os.environ.get("ALLOWED_ORIGINS"), DEV)
BOT_USERNAME = os.environ.get("BOT_USERNAME", "").strip().lstrip("@")  # пусто — узнаем через getMe

# Премиум-эмодзи
E = {
    "bot": "6030400221232501136",
    "apps": "5778672437122045013",
    "bell": "6039486778597970865",
    "clock": "5983150113483134607",
    "info": "6028435952299413210",
    "check": "5870633910337015697",
    "cross": "5870657884844462243",
    "calendar": "5890937706803894250",
    "growth": "5870930636742595124",
    "stats": "5870921681735781843",
    "party": "6041731551845159060",
    "settings": "5870982283724328568",
    "profile": "5870994129244131212",
    "people": "5870772616305839506",
    "user_ok": "5891207662678317861",
    "user_no": "5893192487324880883",
    "time": "5775896410780079073",
    "megaphone": "6039422865189638057",
    "file": "5870528606328852614",
    "download": "6039802767931871481",
    "write": "5870753782874246579",
    "eye": "6037397706505195857",
    "lock": "6037249452824072506",
    "home": "5873147866364514353",
    "send": "5963103826075456248",
    "loading": "5345906554510012647",
}
FALLBACK = {
    "bot": "🤖", "apps": "📦", "bell": "🔔", "clock": "⏰", "info": "ℹ️", "check": "✅", "cross": "❌",
    "calendar": "📅", "growth": "📊", "stats": "📊", "party": "🎉", "settings": "⚙️", "profile": "👤",
    "people": "👥", "user_ok": "👤", "user_no": "👤", "time": "🕓", "megaphone": "📣", "file": "📁",
    "download": "⬇️", "write": "✍️", "eye": "👁", "lock": "🔒", "home": "🏘", "send": "⬆️", "loading": "🔄",
}


def em(name: str) -> str:
    return f'<tg-emoji emoji-id="{E[name]}">{FALLBACK[name]}</tg-emoji>'


def btn(text: str, icon: str | None = None, **kw) -> InlineKeyboardButton:
    return InlineKeyboardButton(text=text, icon_custom_emoji_id=E[icon] if icon else None, **kw)


WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]
WATER_FROM, WATER_TO = 10, 21
TRAIN_HOURS = [7, 8, 9, 12, 17, 18]
INTERVALS = [1, 2, 3]
GOALS = {"lose": "Похудеть", "maintain": "Поддерживать", "gain": "Набрать"}
LEVELS = {"beginner": "Новичок", "intermediate": "Средний", "advanced": "Профи"}
SEXES = {"m": "Мужчины", "f": "Женщины"}


# ── База ────────────────────────────────────────────────
@dataclass
class User:
    id: int
    name: str
    username: str = ""
    days: str = ""
    tz: int = 180
    weight: int = 0
    goal: str = ""
    level: str = ""
    sex: str = ""
    water_on: int = 1
    train_on: int = 1
    interval: int = 2
    train_hour: int = 9
    last_water: str = ""
    last_train: str = ""
    blocked: int = 0
    first_seen: str = ""
    last_seen: str = ""


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


class DB:
    # Все колонки users: таблицу мог создать и api.Store (в нём только общие поля) — добираем недостающие
    COLUMNS = {
        "name": "TEXT DEFAULT ''", "days": "TEXT DEFAULT ''", "tz": "INTEGER DEFAULT 180", "weight": "INTEGER DEFAULT 0",
        "water_on": "INTEGER DEFAULT 1", "train_on": "INTEGER DEFAULT 1", "interval": "INTEGER DEFAULT 2",
        "train_hour": "INTEGER DEFAULT 9", "last_water": "TEXT DEFAULT ''", "last_train": "TEXT DEFAULT ''",
        "username": "TEXT DEFAULT ''", "goal": "TEXT DEFAULT ''", "level": "TEXT DEFAULT ''", "sex": "TEXT DEFAULT ''",
        "blocked": "INTEGER DEFAULT 0", "first_seen": "TEXT DEFAULT ''", "last_seen": "TEXT DEFAULT ''",
    }

    def __init__(self, path: str):
        self.conn = sqlite3.connect(path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute(
            """CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY, name TEXT DEFAULT '', days TEXT DEFAULT '', tz INTEGER DEFAULT 180,
                weight INTEGER DEFAULT 0, water_on INTEGER DEFAULT 1, train_on INTEGER DEFAULT 1,
                interval INTEGER DEFAULT 2, train_hour INTEGER DEFAULT 9,
                last_water TEXT DEFAULT '', last_train TEXT DEFAULT '')"""
        )
        have = {r[1] for r in self.conn.execute("PRAGMA table_info(users)")}
        for col, ddl in self.COLUMNS.items():
            if col not in have:
                self.conn.execute(f"ALTER TABLE users ADD COLUMN {col} {ddl}")
        self.conn.commit()

    def get(self, uid: int) -> User | None:
        row = self.conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
        return User(**dict(row)) if row else None

    def touch(self, tg_user) -> User:
        ts = now_iso()
        self.conn.execute(
            "INSERT OR IGNORE INTO users (id, name, username, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)",
            (tg_user.id, tg_user.first_name or "", tg_user.username or "", ts, ts),
        )
        self.conn.execute(
            "UPDATE users SET name = ?, username = ?, last_seen = ?, blocked = 0 WHERE id = ?",
            (tg_user.first_name or "", tg_user.username or "", ts, tg_user.id),
        )
        self.conn.commit()
        return self.get(tg_user.id)

    def update(self, uid: int, **fields) -> User:
        cols = ", ".join(f"{k} = ?" for k in fields)
        self.conn.execute(f"UPDATE users SET {cols} WHERE id = ?", (*fields.values(), uid))
        self.conn.commit()
        return self.get(uid)

    def with_schedule(self) -> list[User]:
        rows = self.conn.execute(
            "SELECT * FROM users WHERE weight > 0 AND blocked = 0 AND (water_on = 1 OR train_on = 1)"
        ).fetchall()
        return [User(**dict(r)) for r in rows]

    def all_active_ids(self) -> list[int]:
        return [r[0] for r in self.conn.execute("SELECT id FROM users WHERE blocked = 0")]

    def scalar(self, sql: str, *args) -> int:
        return self.conn.execute(sql, args).fetchone()[0] or 0

    def mark_blocked(self, uid: int) -> None:
        self.conn.execute("UPDATE users SET blocked = 1 WHERE id = ?", (uid,))
        self.conn.commit()

    def blocked_among(self, ids: list[int]) -> set[int]:
        if not ids:
            return set()
        marks = ",".join("?" * len(ids))
        return {r[0] for r in self.conn.execute(f"SELECT id FROM users WHERE blocked = 1 AND id IN ({marks})", ids)}

    def recent(self, n: int = 10) -> list[User]:
        rows = self.conn.execute("SELECT * FROM users ORDER BY first_seen DESC LIMIT ?", (n,)).fetchall()
        return [User(**dict(r)) for r in rows]

    def export_csv(self) -> bytes:
        rows = self.conn.execute("SELECT * FROM users ORDER BY first_seen").fetchall()
        buf = io.StringIO()
        writer = csv.writer(buf)
        if rows:
            writer.writerow(rows[0].keys())
            writer.writerows([tuple(r) for r in rows])
        return buf.getvalue().encode("utf-8-sig")


db = DB(DB_PATH)
store = api.Store(db.conn)  # таблицы мини-аппа и челленджей в той же базе
dp = Dispatcher()


class Broadcast(StatesGroup):
    waiting = State()
    confirm = State()


def is_admin(uid: int) -> bool:
    return uid in ADMIN_IDS


# ── Тексты и клавиатуры ─────────────────────────────────
def webapp_url(**params: str) -> str:
    """WEBAPP_URL + параметры (?ch=…) + ?api=<PUBLIC_URL>, чтобы мини-апп знал адрес сервера."""
    parts = urlsplit(WEBAPP_URL)
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k not in params and k != "api"]
    query += [(k, str(v)) for k, v in params.items() if v not in (None, "")]
    if PUBLIC_URL:
        query.append(("api", PUBLIC_URL))
    return urlunsplit(parts._replace(query=urlencode(query)))


def app_button(text: str = "Открыть GymApp", icon: str = "apps", **params: str) -> InlineKeyboardButton:
    return btn(text, icon, web_app=WebAppInfo(url=webapp_url(**params)))


def esc(text) -> str:
    return html.escape(str(text or ""), quote=False)


def start_keyboard(uid: int) -> InlineKeyboardMarkup:
    rows = [
        [app_button()],
        [btn("Напоминания", "bell", callback_data="remind"), btn("Как это работает", "info", callback_data="how")],
    ]
    if is_admin(uid):
        rows.append([btn("Админ-панель", "settings", callback_data="adm")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def start_text(name: str) -> str:
    return (
        f"<b>{em('bot')} Привет, {name}!</b>\n\n"
        "Я — твой персональный фитнес-помощник для зала.\n\n"
        f"{em('growth')} Составлю программу тренировок под твой уровень и тренажёры\n"
        f"{em('stats')} Посчитаю КБЖУ под цель: похудеть, набрать или держать форму\n"
        f"{em('bell')} Напомню попить воды и о дне тренировки\n\n"
        "Жми «Открыть GymApp» и ответь на пару вопросов — это займёт минуту."
    )


def how_text() -> str:
    return (
        f"<b>{em('info')} Как это работает</b>\n\n"
        f"{em('profile')} <b>Анкета.</b> Пол, возраст, рост, вес, цель, опыт и дни тренировок.\n\n"
        f"{em('settings')} <b>Твой зал.</b> Отмечаешь тренажёры — программа собирается только из них.\n\n"
        f"{em('growth')} <b>Программа.</b> Новичку — фулбади 2–3 раза в неделю, среднему — верх/низ, "
        "профи — жимы/тяги/ноги. Во время тренировки записываешь веса, а я подсказываю, когда прибавлять.\n\n"
        f"{em('stats')} <b>КБЖУ.</b> Формула Миффлина — Сан Жеора × активность, дефицит 20% или профицит 10–15%.\n\n"
        f"{em('clock')} <b>Вода.</b> 30 мл на кг веса, в день тренировки — 40 мл на кг."
    )


def back_keyboard(to: str = "home") -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[[app_button()], [btn("◁ Назад", callback_data=to)]])


def tz_text(tz: int) -> str:
    sign = "+" if tz >= 0 else "−"
    h, m = divmod(abs(tz), 60)
    return f"UTC{sign}{h}" + (f":{m:02d}" if m else "")


def days_text(days: str) -> str:
    return ", ".join(WEEKDAYS[int(d) - 1] for d in days if d.isdigit() and 1 <= int(d) <= 7) or "не выбраны"


def water_norm(u: User, training: bool) -> int:
    ml = u.weight * (40 if training else 30)
    return max(1500, min(5000, round(ml / 50) * 50))


def remind_text(u: User) -> str:
    if not u.weight:
        return (
            f"<b>{em('bell')} Напоминания</b>\n\n"
            "Чтобы я знал твои дни тренировок и норму воды, открой GymApp → "
            "<b>Профиль</b> → <b>Напоминания в боте</b>."
        )
    water = f"{em('check')} включены" if u.water_on else f"{em('cross')} выключены"
    train = f"{em('check')} включены" if u.train_on else f"{em('cross')} выключены"
    return (
        f"<b>{em('bell')} Напоминания</b>\n\n"
        f"<b>Вода</b> — {water}\n"
        f"Каждые {u.interval} ч с {WATER_FROM}:00 до {WATER_TO}:00. "
        f"Норма: {water_norm(u, False)} мл, в день тренировки — {water_norm(u, True)} мл.\n\n"
        f"<b>Тренировки</b> — {train}\n"
        f"{em('calendar')} {days_text(u.days)} в {u.train_hour}:00\n\n"
        f"{em('time')} Часовой пояс: {tz_text(u.tz)}"
    )


def remind_keyboard(u: User) -> InlineKeyboardMarkup:
    if not u.weight:
        return back_keyboard()
    return InlineKeyboardMarkup(inline_keyboard=[
        [btn(f"Вода: {'вкл' if u.water_on else 'выкл'}", "check" if u.water_on else "cross", callback_data="t:water"),
         btn(f"Тренировки: {'вкл' if u.train_on else 'выкл'}", "check" if u.train_on else "cross", callback_data="t:train")],
        [btn(f"Вода каждые {u.interval} ч", "clock", callback_data="t:interval"),
         btn(f"Трен-ка в {u.train_hour}:00", "calendar", callback_data="t:hour")],
        [btn("◁ Назад", callback_data="home")],
    ])


# ── Пользовательские хэндлеры ──────────────────────────
# r_<дни>_<часовой пояс в минутах, m = минус>_<вес>[_<цель><уровень><пол>]
PAYLOAD = re.compile(r"^r_([1-7]{0,7})_(m?\d{1,3})_(\d{2,3})(?:_([lmg])([bia])([mf]))?$")
# ch_<код челленджа> — приглашение из мини-аппа
CH_PAYLOAD = re.compile(r"^ch_([A-Za-z0-9]{6})$")


@dp.message(CommandStart())
async def cmd_start(message: Message, command: CommandObject, state: FSMContext, bot: Bot):
    await state.clear()
    is_new = db.get(message.from_user.id) is None
    u = db.touch(message.from_user)
    if is_new and is_admin(u.id):
        await setup_admin_commands(bot, u.id)
    ch_match = CH_PAYLOAD.match(command.args or "")
    if ch_match:
        await show_challenge_card(message, bot, ch_match.group(1).upper())
        return
    match = PAYLOAD.match(command.args or "")
    if match:
        days, tz, weight, goal, level, sex = match.groups()
        tz_val = -int(tz[1:]) if tz.startswith("m") else int(tz)
        if -720 <= tz_val <= 840 and 35 <= int(weight) <= 250:
            extra = {"goal": goal, "level": level, "sex": sex} if goal else {}
            u = db.update(u.id, days="".join(sorted(set(days))), tz=tz_val, weight=int(weight), **extra)
            await message.answer(
                f"<b>{em('party')} Готово! Напоминания настроены</b>\n\n" + remind_text(u).split("\n\n", 1)[1],
                reply_markup=remind_keyboard(u),
            )
            return
    await message.answer(start_text(esc(message.from_user.first_name or "атлет")), reply_markup=start_keyboard(u.id))


@dp.message(Command("app"))
async def cmd_app(message: Message):
    db.touch(message.from_user)
    await message.answer(
        f"<b>{em('apps')} GymApp</b>\n\nТвоя программа, КБЖУ и вода — в приложении.",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[[app_button()]]),
    )


@dp.message(Command("remind"))
async def cmd_remind(message: Message):
    u = db.touch(message.from_user)
    await message.answer(remind_text(u), reply_markup=remind_keyboard(u))


@dp.message(Command("help"))
async def cmd_help(message: Message):
    db.touch(message.from_user)
    await message.answer(how_text(), reply_markup=back_keyboard())


@dp.callback_query(F.data == "home")
async def cb_home(callback: CallbackQuery, state: FSMContext):
    await state.clear()
    u = db.touch(callback.from_user)
    await callback.message.edit_text(start_text(esc(callback.from_user.first_name or "атлет")), reply_markup=start_keyboard(u.id))
    await callback.answer()


@dp.callback_query(F.data == "how")
async def cb_how(callback: CallbackQuery):
    await callback.message.edit_text(how_text(), reply_markup=back_keyboard())
    await callback.answer()


@dp.callback_query(F.data == "remind")
async def cb_remind(callback: CallbackQuery):
    u = db.touch(callback.from_user)
    await callback.message.edit_text(remind_text(u), reply_markup=remind_keyboard(u))
    await callback.answer()


@dp.callback_query(F.data.startswith("t:"))
async def cb_toggle(callback: CallbackQuery):
    u = db.touch(callback.from_user)
    what = callback.data[2:]
    if what == "water":
        u = db.update(u.id, water_on=0 if u.water_on else 1)
    elif what == "train":
        u = db.update(u.id, train_on=0 if u.train_on else 1)
    elif what == "interval":
        u = db.update(u.id, interval=INTERVALS[(INTERVALS.index(u.interval) + 1) % len(INTERVALS)] if u.interval in INTERVALS else 2)
    elif what == "hour":
        u = db.update(u.id, train_hour=TRAIN_HOURS[(TRAIN_HOURS.index(u.train_hour) + 1) % len(TRAIN_HOURS)] if u.train_hour in TRAIN_HOURS else 9)
    await callback.message.edit_text(remind_text(u), reply_markup=remind_keyboard(u))
    await callback.answer("Сохранено")


# ── Челленджи ──────────────────────────────────────────
# Как сказать о победе: «<имя> первым пожал 100 кг в жиме лёжа!» ({a} — окончание для женского рода)
LIFT_WIN = {
    "bb_bench": "пожал{a} {t} кг в жиме лёжа",
    "db_bench": "пожал{a} {t} кг в жиме гантелей лёжа",
    "bb_squat": "присел{a} со штангой {t} кг",
    "deadlift": "потянул{a} {t} кг в становой тяге",
    "bb_ohp": "выжал{a} {t} кг стоя",
    "leg_press": "пожал{a} {t} кг в жиме ногами",
}


def ch_amount(ch: dict, value: float) -> str:
    if ch["type"] == "workouts":
        return f"{api.fmt_num(value)} {api.plural(value, 'тренировка', 'тренировки', 'тренировок')}"
    return f"{api.fmt_num(value)} кг"


def ch_goal(ch: dict) -> str:
    if ch["type"] == "lift":
        return f"Кто первым возьмёт {api.fmt_num(ch['target'])} кг в упражнении «{esc(ch['exercise_name'])}»"
    period = f"за {ch['days']} {api.plural(ch['days'], 'день', 'дня', 'дней')}"
    if ch["type"] == "workouts":
        return f"Кто первым сделает {ch_amount(ch, ch['target'])} {period}"
    return f"Кто первым наберёт {api.fmt_num(ch['target'])} кг объёма {period}"


def ch_deadline(ch: dict) -> str:
    if not ch["ends_on"]:
        return "без срока — до первого, кто возьмёт вес"
    end = date.fromisoformat(ch["ends_on"])
    text = f"до {end.day:02d}.{end.month:02d}"
    left = (end - datetime.now(timezone.utc).date()).days + 1
    if ch["status"] == "active" and left > 0:
        text += f" · осталось {left} {api.plural(left, 'день', 'дня', 'дней')}"
    return text


def ch_win_phrase(ch: dict, sex: str) -> str:
    fem = sex == "f"
    first = "первой" if fem else "первым"
    if ch["type"] == "lift" and ch["exercise"] in LIFT_WIN:
        return f"{first} " + LIFT_WIN[ch["exercise"]].format(a="а" if fem else "", t=api.fmt_num(ch["target"]))
    return f"{first} {'достигла' if fem else 'достиг'} цели «{esc(ch['title'])}»"


def ch_standings(ch: dict, me: int | None = None, limit: int = 10) -> str:
    lines = []
    for place, p in enumerate(ch["participants"][:limit], 1):
        line = f"{place}. {esc(p['name'])}{' (ты)' if p['id'] == me else ''} — {ch_amount(ch, p['progress'])}"
        lines.append(f"<b>{line}</b>" if p["id"] == me else line)
    rest = len(ch["participants"]) - limit
    if rest > 0:
        lines.append(f"…и ещё {rest}")
    return "\n".join(lines) or "Пока никого."


def ch_keyboard(ch: dict, member: bool = True, back: bool = False) -> InlineKeyboardMarkup:
    if ch["status"] == "active" and not member:
        first = app_button("Принять вызов", "check", ch=ch["code"])
    else:
        first = app_button("Открыть челлендж", ch=ch["code"])
    rows = [[first]]
    if back:
        rows.append([btn("◁ В меню", callback_data="home")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def challenge_card(ch: dict, uid: int) -> str:
    member = any(p["is_me"] for p in ch["participants"])
    creator = db.get(ch["created_by"])
    if ch["status"] != "active":
        head = f"{em('stats')} <b>Челлендж завершён</b>"
    elif member:
        head = f"{em('growth')} <b>Ты в челлендже</b>"
    else:
        head = f"{em('party')} <b>Тебя вызывают на челлендж!</b>"
    text = (
        f"{head}\n\n<b>{esc(ch['title'])}</b>\n{ch_goal(ch)}.\n\n"
        f"{em('profile')} Вызов бросил: <b>{esc(creator.name if creator and creator.name else 'Атлет')}</b>\n"
        f"{em('calendar')} Срок: {ch_deadline(ch)}\n"
        f"{em('people')} Участников: <b>{len(ch['participants'])}</b> из {api.MAX_PARTICIPANTS}\n\n"
        f"<b>Таблица</b>\n{ch_standings(ch, uid)}"
    )
    if ch["status"] != "active":
        w = ch["winner"]
        text += f"\n\n{em('party')} Победитель: <b>{esc(w['name'])}</b>" if w else "\n\nЦели никто не достиг — без победителя."
    elif member:
        text += "\n\nЖми «Открыть челлендж» — там прогресс и ссылка для друзей."
    else:
        text += "\n\nЖми «Принять вызов» — откроется GymApp, и ты в игре."
    return text


async def show_challenge_card(message: Message, bot: Bot, code: str) -> None:
    row = store.challenge(code)
    if not row:
        await message.answer(
            f"<b>{em('cross')} Челлендж не найден</b>\n\nПроверь ссылку — возможно, в ней опечатка "
            "или челлендж удалён.",
            reply_markup=start_keyboard(message.from_user.id),
        )
        return
    events = store.recompute(row)  # заодно завершим, если срок вышел
    ch = store.challenge_dict(store.challenge(code), message.from_user.id, BOT_USERNAME)
    member = any(p["is_me"] for p in ch["participants"])
    await message.answer(challenge_card(ch, message.from_user.id), reply_markup=ch_keyboard(ch, member, back=True))
    if events:
        await api.deliver(TelegramNotifier(bot), store.notifications(events, BOT_USERNAME))


class Throttle:
    """Общий темп рассылок на весь процесс: уведомления челленджей, напоминания и рассылка админа
    идут через одну «очередь» слотов — не больше rate сообщений в секунду (лимит Telegram ~30/с на бота).
    Без asyncio.Lock: слот резервируется синхронно, поэтому объект не привязан к циклу событий."""

    def __init__(self, rate: float = 20):
        self.interval = 1 / rate if rate else 0.0
        self.next = 0.0

    async def wait(self) -> None:
        now = time.monotonic()
        slot = max(now, self.next)
        self.next = slot + self.interval
        if slot > now:
            await asyncio.sleep(slot - now)

    def pause(self, seconds: float) -> None:
        """Telegram ответил RetryAfter — притормозить всех отправителей, а не только этого."""
        self.next = max(self.next, time.monotonic() + seconds)


THROTTLE = Throttle(20)  # оставляем запас под ответы на команды


async def deliver_message(bot: Bot, uid: int, text: str, markup: InlineKeyboardMarkup | None = None) -> bool:
    """Отправить сообщение, не роняя вызывающий код. Заблокировавших бота — помечаем."""
    for attempt in range(2):
        await THROTTLE.wait()
        try:
            await bot.send_message(uid, text, reply_markup=markup)
            return True
        except TelegramRetryAfter as e:
            THROTTLE.pause(min(e.retry_after, 60) + 1)
            if attempt:
                logging.warning("send to %s dropped: flood control", uid)
                break
        except TelegramForbiddenError:
            db.mark_blocked(uid)  # пользователь заблокировал бота
            return False
        except Exception as e:  # noqa: BLE001 — не роняем рассылку из-за одного пользователя
            logging.warning("send to %s failed: %s", uid, e)
            return False
    return False


class TelegramNotifier(api.Notifier):
    """Уведомления участникам челленджей (вызывается из api.py и планировщика)."""

    def __init__(self, bot: Bot):
        self.bot = bot

    async def _each(self, ch: dict, text_for, skip: int | None = None) -> None:
        ids = [p["id"] for p in ch["participants"] if p["id"] != skip]
        blocked = db.blocked_among(ids)
        markup = ch_keyboard(ch)
        for uid in ids:
            if uid not in blocked:
                await deliver_message(self.bot, uid, text_for(uid), markup)  # темп — общий THROTTLE

    async def joined(self, ch: dict, user: dict) -> None:
        verb = "приняла" if store.user_sex(user["id"]) == "f" else "принял"
        n = len(ch["participants"])
        text = (
            f"{em('people')} <b>{esc(user['name'])}</b> {verb} вызов «{esc(ch['title'])}»\n\n"
            f"Теперь участников: <b>{n}</b>. Не отставай!"
        )
        await self._each(ch, lambda uid: text, skip=user["id"])

    async def winner(self, ch: dict) -> None:
        w = ch["winner"]
        phrase = ch_win_phrase(ch, store.user_sex(w["id"]))

        def text_for(uid: int) -> str:
            head = (f"{em('party')} <b>Победа!</b> Ты {phrase}!" if uid == w["id"]
                    else f"{em('party')} <b>{esc(w['name'])}</b> {phrase}!")
            return f"{head}\n\nЧеллендж «{esc(ch['title'])}» завершён.\n\n<b>Итоги</b>\n{ch_standings(ch, uid)}"

        await self._each(ch, text_for)

    async def finished(self, ch: dict) -> None:
        w = ch["winner"]
        places = {p["id"]: i for i, p in enumerate(ch["participants"], 1)}

        def text_for(uid: int) -> str:
            text = f"{em('stats')} <b>Челлендж «{esc(ch['title'])}» завершён</b>\n\nСрок вышел. "
            if not w:
                text += "Цели никто не достиг — в этот раз без победителя."
            elif uid == w["id"]:
                text += f"{em('party')} <b>Ты победил{'а' if store.user_sex(uid) == 'f' else ''}</b> — у тебя лучший результат!"
            else:
                text += f"Победитель — <b>{esc(w['name'])}</b>."
            text += f"\n\n<b>Места</b>\n{ch_standings(ch, uid)}"
            if uid in places:
                text += f"\n\nТвоё место: <b>{places[uid]}</b> из {len(places)}"
            return text

        await self._each(ch, text_for)


# ── Админ-панель ───────────────────────────────────────
def admin_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [btn("Статистика", "stats", callback_data="adm:stats"), btn("Новые", "people", callback_data="adm:users")],
        [btn("Рассылка", "megaphone", callback_data="adm:bc")],
        [btn("Выгрузить CSV", "download", callback_data="adm:csv"), app_button("Мини-апп")],
        [btn("◁ Назад", callback_data="home")],
    ])


def admin_back() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[[btn("◁ Назад", callback_data="adm")]])


def admin_text() -> str:
    total = db.scalar("SELECT COUNT(*) FROM users")
    return (
        f"<b>{em('settings')} Админ-панель</b>\n\n"
        f"{em('people')} Пользователей: <b>{total}</b>\n"
        "Выбери раздел:"
    )


def pct(n: int, total: int) -> str:
    return f"{n} ({round(n * 100 / total)}%)" if total else str(n)


def stats_text() -> str:
    q = db.scalar
    total = q("SELECT COUNT(*) FROM users")
    since = lambda days: (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")  # noqa: E731
    new1, new7, new30 = (q("SELECT COUNT(*) FROM users WHERE first_seen >= ?", since(d)) for d in (1, 7, 30))
    act1, act7 = (q("SELECT COUNT(*) FROM users WHERE last_seen >= ?", since(d)) for d in (1, 7))
    blocked = q("SELECT COUNT(*) FROM users WHERE blocked = 1")
    connected = q("SELECT COUNT(*) FROM users WHERE weight > 0")
    water = q("SELECT COUNT(*) FROM users WHERE weight > 0 AND water_on = 1 AND blocked = 0")
    train = q("SELECT COUNT(*) FROM users WHERE weight > 0 AND train_on = 1 AND blocked = 0")
    avg_w = q("SELECT ROUND(AVG(weight)) FROM users WHERE weight > 0")
    avg_d = db.conn.execute("SELECT AVG(LENGTH(days)) FROM users WHERE weight > 0").fetchone()[0] or 0
    app = store.admin_stats()  # сводки из мини-аппа (app_stats) + челленджи

    def dist(counts: dict, names: dict) -> str:
        n = sum(counts.values())
        items = sorted(((k, v) for k, v in counts.items() if v), key=lambda kv: -kv[1])
        return " · ".join(f"{names.get(k, k)} {round(v * 100 / n)}%" for k, v in items) if n else "нет данных"

    return (
        f"<b>{em('stats')} Статистика</b>\n\n"
        f"{em('people')} Всего пользователей: <b>{total}</b>\n"
        f"{em('growth')} Новые: за сутки <b>{new1}</b> · 7 дней <b>{new7}</b> · 30 дней <b>{new30}</b>\n"
        f"{em('eye')} Активны: за сутки <b>{act1}</b> · 7 дней <b>{act7}</b>\n"
        f"{em('user_no')} Заблокировали бота: <b>{pct(blocked, total)}</b>\n\n"
        f"<b>{em('bell')} Напоминания</b>\n"
        f"Подключили из приложения: <b>{pct(connected, total)}</b>\n"
        f"Вода: <b>{water}</b> · Тренировки: <b>{train}</b>\n"
        f"Средний вес: <b>{avg_w:.0f} кг</b> · Тренировок в неделю: <b>{avg_d:.1f}</b>\n\n"
        f"<b>{em('apps')} Мини-апп</b>\n"
        f"Синхронизировались: <b>{pct(app['synced_users'], total)}</b>\n"
        f"Всего тренировок: <b>{api.fmt_num(app['workouts_total'])}</b>\n"
        f"Челленджи: активных <b>{app['challenges_active']}</b> · завершено <b>{app['challenges_finished']}</b> · "
        f"участников <b>{app['challenge_participants']}</b>\n\n"
        f"<b>{em('profile')} Кто пользуется</b>\n"
        f"Цель: {dist(app['goals'], GOALS)}\n"
        f"Уровень: {dist(app['levels'], LEVELS)}\n"
        f"Пол: {dist(app['sexes'], SEXES)}"
    )


def users_text() -> str:
    lines = [f"<b>{em('people')} Последние пользователи</b>\n"]
    for u in db.recent(15):
        mark = em("user_no") if u.blocked else em("user_ok")
        uname = f" @{esc(u.username)}" if u.username else ""
        date = u.first_seen[:16].replace("-", ".") if u.first_seen else "—"
        lines.append(f"{mark} {esc(u.name or 'без имени')}{uname} · <code>{u.id}</code> · {date}")
    return "\n".join(lines) if len(lines) > 1 else lines[0] + "\nПока никого."


async def admin_only(callback: CallbackQuery) -> bool:
    if not is_admin(callback.from_user.id):
        await callback.answer("Нет доступа", show_alert=True)
        return False
    return True


@dp.message(Command("admin"))
async def cmd_admin(message: Message, state: FSMContext):
    if not is_admin(message.from_user.id):
        return
    await state.clear()
    db.touch(message.from_user)
    await message.answer(admin_text(), reply_markup=admin_keyboard())


@dp.callback_query(F.data == "adm")
async def cb_admin(callback: CallbackQuery, state: FSMContext):
    if not await admin_only(callback):
        return
    await state.clear()
    await callback.message.edit_text(admin_text(), reply_markup=admin_keyboard())
    await callback.answer()


@dp.callback_query(F.data == "adm:stats")
async def cb_stats(callback: CallbackQuery):
    if not await admin_only(callback):
        return
    kb = InlineKeyboardMarkup(inline_keyboard=[[btn("Обновить", "loading", callback_data="adm:stats")], [btn("◁ Назад", callback_data="adm")]])
    try:
        await callback.message.edit_text(stats_text(), reply_markup=kb)
    except TelegramBadRequest:
        pass  # ничего не изменилось
    await callback.answer()


@dp.callback_query(F.data == "adm:users")
async def cb_users(callback: CallbackQuery):
    if not await admin_only(callback):
        return
    await callback.message.edit_text(users_text(), reply_markup=admin_back())
    await callback.answer()


@dp.callback_query(F.data == "adm:csv")
async def cb_csv(callback: CallbackQuery):
    if not await admin_only(callback):
        return
    name = f"gymapp_users_{datetime.now():%Y%m%d}.csv"
    await callback.message.answer_document(
        BufferedInputFile(db.export_csv(), filename=name),
        caption=f"{em('file')} Все пользователи бота",
    )
    await callback.answer()


@dp.callback_query(F.data == "adm:bc")
async def cb_broadcast(callback: CallbackQuery, state: FSMContext):
    if not await admin_only(callback):
        return
    await state.set_state(Broadcast.waiting)
    await callback.message.edit_text(
        f"<b>{em('megaphone')} Рассылка</b>\n\n"
        "Отправь сообщение, которое получат все пользователи: текст, фото, видео — что угодно. "
        "Перед отправкой я покажу, как оно выглядит.",
        reply_markup=admin_back(),
    )
    await callback.answer()


@dp.message(Broadcast.waiting)
async def bc_preview(message: Message, state: FSMContext):
    if not is_admin(message.from_user.id):
        return
    await state.update_data(chat_id=message.chat.id, message_id=message.message_id)
    await state.set_state(Broadcast.confirm)
    n = len(db.all_active_ids())
    await message.answer(
        f"<b>{em('eye')} Так увидят пользователи</b> — сообщение выше.\n\nОтправить {n} пользователям?",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[
            [btn(f"Отправить ({n})", "send", callback_data="bc:go")],
            [btn("Отмена", "cross", callback_data="adm")],
        ]),
    )


@dp.callback_query(Broadcast.confirm, F.data == "bc:go")
async def bc_send(callback: CallbackQuery, state: FSMContext, bot: Bot):
    if not await admin_only(callback):
        return
    data = await state.get_data()
    await state.clear()
    ids = db.all_active_ids()
    await callback.message.edit_text(f"{em('loading')} Отправляю {len(ids)} пользователям…")
    await callback.answer()
    ok = fail = 0
    for uid in ids:
        await THROTTLE.wait()  # общий темп с уведомлениями и напоминаниями
        try:
            await bot.copy_message(uid, data["chat_id"], data["message_id"])
            ok += 1
        except TelegramRetryAfter as e:
            THROTTLE.pause(min(e.retry_after, 60) + 1)
            await THROTTLE.wait()
            try:
                await bot.copy_message(uid, data["chat_id"], data["message_id"])
                ok += 1
            except Exception:  # noqa: BLE001
                fail += 1
        except TelegramForbiddenError:
            db.update(uid, blocked=1)
            fail += 1
        except Exception:  # noqa: BLE001
            fail += 1
    await callback.message.edit_text(
        f"<b>{em('check')} Рассылка завершена</b>\n\nДоставлено: <b>{ok}</b>\nНе доставлено: <b>{fail}</b>",
        reply_markup=admin_back(),
    )


# ── Планировщик напоминаний ────────────────────────────
async def send_safe(bot: Bot, u: User, text: str, button: str) -> bool:
    return await deliver_message(bot, u.id, text, InlineKeyboardMarkup(inline_keyboard=[[app_button(button)]]))


async def tick(bot: Bot) -> None:
    now = datetime.now(timezone.utc)
    for u in db.with_schedule():
        local = now + timedelta(minutes=u.tz)
        today = local.strftime("%Y-%m-%d")
        training = str(local.isoweekday()) in u.days

        if u.train_on and training and local.hour == u.train_hour and u.last_train != today:
            text = (
                f"<b>{em('calendar')} Сегодня день тренировки!</b>\n\n"
                "Программа уже ждёт в приложении. Не забудь разминку и бутылку воды — "
                f"сегодня норма {water_norm(u, True)} мл."
            )
            await send_safe(bot, u, text, "Открыть тренировку")
            db.update(u.id, last_train=today)

        slot = f"{today} {local.hour}"
        if (
            u.water_on
            and WATER_FROM <= local.hour <= WATER_TO
            and (local.hour - WATER_FROM) % max(1, u.interval) == 0
            and u.last_water != slot
        ):
            glasses = max(1, round(water_norm(u, training) / ((WATER_TO - WATER_FROM) // max(1, u.interval) + 1) / 50) * 50)
            text = (
                f"<b>{em('clock')} Время выпить воды</b>\n\n"
                f"Выпей около {glasses} мл и отметь в приложении. "
                f"Норма на сегодня — {water_norm(u, training)} мл."
            )
            await send_safe(bot, u, text, "Отметить воду")
            db.update(u.id, last_water=slot)


async def challenges_tick(notifier: api.Notifier) -> None:
    """Завершить челленджи с истёкшим сроком и разослать итоги."""
    events = store.finish_expired()
    if events:
        await api.deliver(notifier, store.notifications(events, BOT_USERNAME))


async def scheduler(bot: Bot, notifier: api.Notifier | None = None) -> None:
    notifier = notifier or TelegramNotifier(bot)
    while True:
        for job in (lambda: tick(bot), lambda: challenges_tick(notifier)):
            try:
                await job()
            except Exception:  # noqa: BLE001
                logging.exception("scheduler tick failed")
        await asyncio.sleep(60 - datetime.now().second)


USER_COMMANDS = [
    BotCommand(command="start", description="Главное меню"),
    BotCommand(command="app", description="Открыть приложение"),
    BotCommand(command="remind", description="Напоминания"),
    BotCommand(command="help", description="Как это работает"),
]


async def setup_admin_commands(bot: Bot, admin: int) -> None:
    try:
        await bot.set_my_commands(
            [*USER_COMMANDS[:2], BotCommand(command="admin", description="Админ-панель"), *USER_COMMANDS[2:]],
            scope=BotCommandScopeChat(chat_id=admin),
        )
    except TelegramBadRequest:
        logging.info("admin %s ещё не писал боту — команды для него появятся после /start", admin)


async def setup_bot(bot: Bot) -> None:
    await bot.set_chat_menu_button(menu_button=MenuButtonWebApp(text="Открыть", web_app=WebAppInfo(url=webapp_url())))
    await bot.set_my_commands(USER_COMMANDS)
    for admin in ADMIN_IDS:
        await setup_admin_commands(bot, admin)


def api_config() -> api.ApiConfig:
    return api.ApiConfig(token=BOT_TOKEN, admin_ids=ADMIN_IDS, origins=ALLOWED_ORIGINS, bot_username=BOT_USERNAME)


async def start_api(notifier: api.Notifier) -> web.AppRunner:
    runner = web.AppRunner(api.create_app(store, api_config(), notifier), access_log_class=api.AccessLogger)
    await runner.setup()
    try:
        await web.TCPSite(runner, API_HOST, API_PORT).start()
    except OSError as e:
        await runner.cleanup()
        raise SystemExit(f"Не получилось занять порт {API_HOST}:{API_PORT} ({e.strerror}) — "
                         "укажи свободный API_PORT в bot/.env") from e
    logging.info("API слушает %s:%s · CORS: %s", API_HOST, API_PORT, ", ".join(sorted(ALLOWED_ORIGINS)))
    if not PUBLIC_URL:
        logging.warning("PUBLIC_URL не задан — мини-апп не узнает адрес сервера (челленджи не заработают)")
    return runner


async def main() -> None:
    global BOT_USERNAME
    if not BOT_TOKEN:
        raise SystemExit("Укажи BOT_TOKEN в bot/.env (см. .env.example)")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    bot = Bot(BOT_TOKEN, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    try:
        if not BOT_USERNAME:
            BOT_USERNAME = (await bot.get_me()).username or ""
        await setup_bot(bot)
        notifier = TelegramNotifier(bot)
        runner = await start_api(notifier)
        jobs = asyncio.create_task(scheduler(bot, notifier))
        try:
            # SIGINT/SIGTERM (Ctrl+C, docker stop) останавливают polling, дальше — аккуратная уборка
            await dp.start_polling(bot, close_bot_session=False)
        finally:
            jobs.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await jobs
            await runner.cleanup()  # дождётся отправки уведомлений
    finally:
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
