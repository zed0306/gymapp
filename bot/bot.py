"""GymApp bot: открывает мини-апп и напоминает про воду и тренировки.

Запуск:  python bot.py   (переменные окружения — см. .env.example)
"""

import asyncio
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
from aiogram.exceptions import TelegramForbiddenError
from aiogram.filters import Command, CommandObject, CommandStart
from aiogram.types import (
    BotCommand,
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
    "time": "5775896410780079073",
}
FALLBACK = {
    "bot": "🤖", "apps": "📦", "bell": "🔔", "clock": "⏰", "info": "ℹ️", "check": "✅", "cross": "❌",
    "calendar": "📅", "growth": "📊", "stats": "📊", "party": "🎉", "settings": "⚙️", "profile": "👤", "time": "🕓",
}


def em(name: str) -> str:
    return f'<tg-emoji emoji-id="{E[name]}">{FALLBACK[name]}</tg-emoji>'


WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]
WATER_FROM, WATER_TO = 10, 21
TRAIN_HOURS = [7, 8, 9, 12, 17, 18]
INTERVALS = [1, 2, 3]


# ── База ────────────────────────────────────────────────
@dataclass
class User:
    id: int
    name: str
    days: str = ""
    tz: int = 180
    weight: int = 0
    water_on: int = 1
    train_on: int = 1
    interval: int = 2
    train_hour: int = 9
    last_water: str = ""
    last_train: str = ""


class DB:
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
        self.conn.commit()

    def get(self, uid: int) -> User | None:
        row = self.conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
        return User(**dict(row)) if row else None

    def ensure(self, uid: int, name: str) -> User:
        self.conn.execute("INSERT OR IGNORE INTO users (id, name) VALUES (?, ?)", (uid, name))
        self.conn.execute("UPDATE users SET name = ? WHERE id = ?", (name, uid))
        self.conn.commit()
        return self.get(uid)

    def update(self, uid: int, **fields) -> User:
        cols = ", ".join(f"{k} = ?" for k in fields)
        self.conn.execute(f"UPDATE users SET {cols} WHERE id = ?", (*fields.values(), uid))
        self.conn.commit()
        return self.get(uid)

    def with_schedule(self) -> list[User]:
        rows = self.conn.execute("SELECT * FROM users WHERE weight > 0 AND (water_on = 1 OR train_on = 1)").fetchall()
        return [User(**dict(r)) for r in rows]


db = DB(DB_PATH)
dp = Dispatcher()


# ── Тексты и клавиатуры ─────────────────────────────────
def app_button(text: str = "Открыть GymApp") -> InlineKeyboardButton:
    return InlineKeyboardButton(text=text, web_app=WebAppInfo(url=WEBAPP_URL), icon_custom_emoji_id=E["apps"])


def start_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [app_button()],
        [InlineKeyboardButton(text="Напоминания", callback_data="remind", icon_custom_emoji_id=E["bell"])],
        [InlineKeyboardButton(text="Как это работает", callback_data="how", icon_custom_emoji_id=E["info"])],
    ])


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


def back_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [app_button()],
        [InlineKeyboardButton(text="◁ Назад", callback_data="home")],
    ])


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
        [InlineKeyboardButton(
            text=f"Вода: {'вкл' if u.water_on else 'выкл'}", callback_data="t:water",
            icon_custom_emoji_id=E["check"] if u.water_on else E["cross"],
        ), InlineKeyboardButton(
            text=f"Тренировки: {'вкл' if u.train_on else 'выкл'}", callback_data="t:train",
            icon_custom_emoji_id=E["check"] if u.train_on else E["cross"],
        )],
        [InlineKeyboardButton(text=f"Вода каждые {u.interval} ч", callback_data="t:interval", icon_custom_emoji_id=E["clock"]),
         InlineKeyboardButton(text=f"Трен-ка в {u.train_hour}:00", callback_data="t:hour", icon_custom_emoji_id=E["calendar"])],
        [InlineKeyboardButton(text="◁ Назад", callback_data="home")],
    ])


# ── Хэндлеры ───────────────────────────────────────────
PAYLOAD = re.compile(r"^r_([1-7]{0,7})_(m?\d{1,3})_(\d{2,3})$")


@dp.message(CommandStart())
async def cmd_start(message: Message, command: CommandObject):
    u = db.ensure(message.from_user.id, message.from_user.first_name or "")
    match = PAYLOAD.match(command.args or "")
    if match:
        days, tz, weight = match.groups()
        tz_val = -int(tz[1:]) if tz.startswith("m") else int(tz)
        if -720 <= tz_val <= 840 and 35 <= int(weight) <= 250:
            u = db.update(u.id, days="".join(sorted(set(days))), tz=tz_val, weight=int(weight))
            await message.answer(
                f"<b>{em('party')} Готово! Напоминания настроены</b>\n\n" + remind_text(u).split("\n\n", 1)[1],
                reply_markup=remind_keyboard(u),
            )
            return
    await message.answer(start_text(message.from_user.first_name or "атлет"), reply_markup=start_keyboard())


@dp.message(Command("remind"))
async def cmd_remind(message: Message):
    u = db.ensure(message.from_user.id, message.from_user.first_name or "")
    await message.answer(remind_text(u), reply_markup=remind_keyboard(u))


@dp.message(Command("help"))
async def cmd_help(message: Message):
    await message.answer(how_text(), reply_markup=back_keyboard())


@dp.callback_query(F.data == "home")
async def cb_home(callback: CallbackQuery):
    await callback.message.edit_text(start_text(callback.from_user.first_name or "атлет"), reply_markup=start_keyboard())
    await callback.answer()


@dp.callback_query(F.data == "how")
async def cb_how(callback: CallbackQuery):
    await callback.message.edit_text(how_text(), reply_markup=back_keyboard())
    await callback.answer()


@dp.callback_query(F.data == "remind")
async def cb_remind(callback: CallbackQuery):
    u = db.ensure(callback.from_user.id, callback.from_user.first_name or "")
    await callback.message.edit_text(remind_text(u), reply_markup=remind_keyboard(u))
    await callback.answer()


@dp.callback_query(F.data.startswith("t:"))
async def cb_toggle(callback: CallbackQuery):
    u = db.ensure(callback.from_user.id, callback.from_user.first_name or "")
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


# ── Планировщик напоминаний ────────────────────────────
async def send_safe(bot: Bot, u: User, text: str, button: str) -> bool:
    try:
        await bot.send_message(u.id, text, reply_markup=InlineKeyboardMarkup(inline_keyboard=[[app_button(button)]]))
        return True
    except TelegramForbiddenError:
        db.update(u.id, water_on=0, train_on=0)  # пользователь заблокировал бота
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


async def main() -> None:
    if not BOT_TOKEN:
        raise SystemExit("Укажи BOT_TOKEN в bot/.env (см. .env.example)")
    logging.basicConfig(level=logging.INFO)
    bot = Bot(BOT_TOKEN, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    await bot.set_chat_menu_button(menu_button=MenuButtonWebApp(text="GymApp", web_app=WebAppInfo(url=WEBAPP_URL)))
    await bot.set_my_commands([
        BotCommand(command="start", description="Главное меню"),
        BotCommand(command="remind", description="Напоминания"),
        BotCommand(command="help", description="Как это работает"),
    ])
    asyncio.create_task(scheduler(bot))
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
