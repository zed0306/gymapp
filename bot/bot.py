"""GymApp bot: открывает мини-апп, напоминает про воду и тренировки, админ-панель.

Запуск:  python bot.py   (переменные окружения — см. .env.example)
"""

import asyncio
import csv
import io
import logging
import os
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

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
BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
WEBAPP_URL = os.environ.get("WEBAPP_URL", "https://zed0306.github.io/gymapp/")
DB_PATH = os.environ.get("DB_PATH", str(BASE / "gymapp.db"))
ADMIN_IDS = {int(x) for x in re.findall(r"\d+", os.environ.get("ADMIN_IDS", ""))}

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
GOALS = {"l": "Похудеть", "m": "Поддерживать", "g": "Набрать"}
LEVELS = {"b": "Новичок", "i": "Средний", "a": "Профи"}
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
    COLUMNS = {
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

    def group(self, col: str) -> dict[str, int]:
        rows = self.conn.execute(f"SELECT {col}, COUNT(*) FROM users WHERE {col} != '' GROUP BY {col}").fetchall()
        return {r[0]: r[1] for r in rows}

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
dp = Dispatcher()


class Broadcast(StatesGroup):
    waiting = State()
    confirm = State()


def is_admin(uid: int) -> bool:
    return uid in ADMIN_IDS


# ── Тексты и клавиатуры ─────────────────────────────────
def app_button(text: str = "Открыть GymApp") -> InlineKeyboardButton:
    return btn(text, "apps", web_app=WebAppInfo(url=WEBAPP_URL))


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


@dp.message(CommandStart())
async def cmd_start(message: Message, command: CommandObject, state: FSMContext, bot: Bot):
    await state.clear()
    is_new = db.get(message.from_user.id) is None
    u = db.touch(message.from_user)
    if is_new and is_admin(u.id):
        await setup_admin_commands(bot, u.id)
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
    await message.answer(start_text(message.from_user.first_name or "атлет"), reply_markup=start_keyboard(u.id))


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
    await callback.message.edit_text(start_text(callback.from_user.first_name or "атлет"), reply_markup=start_keyboard(u.id))
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

    def dist(col: str, names: dict) -> str:
        g = db.group(col)
        n = sum(g.values())
        return " · ".join(f"{names.get(k, k)} {round(v * 100 / n)}%" for k, v in sorted(g.items(), key=lambda kv: -kv[1])) if n else "нет данных"

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
        f"<b>{em('profile')} Кто пользуется</b>\n"
        f"Цель: {dist('goal', GOALS)}\n"
        f"Уровень: {dist('level', LEVELS)}\n"
        f"Пол: {dist('sex', SEXES)}"
    )


def users_text() -> str:
    lines = [f"<b>{em('people')} Последние пользователи</b>\n"]
    for u in db.recent(15):
        mark = em("user_no") if u.blocked else em("user_ok")
        uname = f" @{u.username}" if u.username else ""
        date = u.first_seen[:16].replace("-", ".") if u.first_seen else "—"
        name = (u.name or "без имени").replace("<", "").replace(">", "")
        lines.append(f"{mark} {name}{uname} · <code>{u.id}</code> · {date}")
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
        try:
            await bot.copy_message(uid, data["chat_id"], data["message_id"])
            ok += 1
        except TelegramRetryAfter as e:
            await asyncio.sleep(e.retry_after + 1)
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
        await asyncio.sleep(0.05)  # не больше ~20 сообщений в секунду
    await callback.message.edit_text(
        f"<b>{em('check')} Рассылка завершена</b>\n\nДоставлено: <b>{ok}</b>\nНе доставлено: <b>{fail}</b>",
        reply_markup=admin_back(),
    )


# ── Планировщик напоминаний ────────────────────────────
async def send_safe(bot: Bot, u: User, text: str, button: str) -> bool:
    try:
        await bot.send_message(u.id, text, reply_markup=InlineKeyboardMarkup(inline_keyboard=[[app_button(button)]]))
        return True
    except TelegramForbiddenError:
        db.update(u.id, blocked=1)  # пользователь заблокировал бота
    except Exception as e:  # noqa: BLE001 — не роняем цикл из-за одного пользователя
        logging.warning("send to %s failed: %s", u.id, e)
    return False


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


async def scheduler(bot: Bot) -> None:
    while True:
        try:
            await tick(bot)
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
    await bot.set_chat_menu_button(menu_button=MenuButtonWebApp(text="Открыть", web_app=WebAppInfo(url=WEBAPP_URL)))
    await bot.set_my_commands(USER_COMMANDS)
    for admin in ADMIN_IDS:
        await setup_admin_commands(bot, admin)


async def main() -> None:
    if not BOT_TOKEN:
        raise SystemExit("Укажи BOT_TOKEN в bot/.env (см. .env.example)")
    logging.basicConfig(level=logging.INFO)
    bot = Bot(BOT_TOKEN, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    await setup_bot(bot)
    asyncio.create_task(scheduler(bot))
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
