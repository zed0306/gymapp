"""HTTP API GymApp: сводка из мини-аппа, челленджи и статистика для админа.

Контракт — docs/ARCHITECTURE.md, раздел «API сервера». Модуль не импортирует bot.py:
бот передаёт сюда соединение с базой (Store) и Notifier, который пишет в Telegram.

    store = Store(sqlite_connection)
    app = create_app(store, ApiConfig(token=BOT_TOKEN, ...), notifier)
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import math
import re
import secrets
import sqlite3
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable
from urllib.parse import parse_qsl

from aiohttp import web
from aiohttp.abc import AbstractAccessLogger

log = logging.getLogger("gymapp.api")

# ── Константы контракта ────────────────────────────────
LIFT_EXERCISES = {
    "bb_bench": "Жим штанги лёжа",
    "bb_squat": "Приседания со штангой",
    "deadlift": "Становая тяга",
    "bb_ohp": "Жим штанги стоя",
    "db_bench": "Жим гантелей лёжа",
    "leg_press": "Жим ногами",
}
# type → (target от, до), (days от, до), целое ли target
TYPES = {
    "lift": ((10, 500), (0, 180), False),
    "workouts": ((1, 100), (1, 90), True),
    "volume": ((1000, 1_000_000), (1, 90), True),
}
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
CODE_LEN = 6
CODE_RE = re.compile(f"^[{CODE_ALPHABET}]{{{CODE_LEN}}}$")
MAX_BODY = 64 * 1024
RATE_LIMIT = 60  # запросов в минуту на пользователя
MAX_ACTIVE = 10  # активных челленджей на человека
MAX_CREATED_PER_DAY = 20  # новых челленджей за сутки на создателя
MAX_PARTICIPANTS = 50
FINISHED_IN_LIST = 10
MAX_PENDING_NOTIFY = 200  # задач уведомлений в очереди; дальше «X принял вызов» не шлём
INIT_MAX_AGE = 7 * 24 * 3600
INIT_FUTURE_SKEW = 5 * 60
DEFAULT_ORIGINS = "https://zed0306.github.io"
DEV_ORIGINS = ("http://127.0.0.1:8080", "http://localhost:8080")

# Сводка из мини-аппа
GOALS = ("lose", "maintain", "gain")
LEVELS = ("beginner", "intermediate", "advanced")
SEXES = ("m", "f")
# Поле stats → разумный максимум (дни серий — до 10 лет, объём — кг за всё время)
STAT_LIMITS = {"workouts": 10_000, "volume": 1e9, "prs": 10_000, "streak": 3660, "bestStreak": 3660, "weekStreak": 3660}
MAX_LIFTS = 300
MAX_HIST = 400  # хранится на сервере (мини-апп присылает до HIST_CLIENT_CAP последних)
HIST_CLIENT_CAP = 60  # S.hist в мини-аппе — последние 60 тренировок
HIST_KEEP_DAYS = 200  # старше — не нужно ни одному челленджу (срок до 90 дней)
MAX_PER_DAY = 3  # тренировок за одну дату, которые идут в зачёт
MAX_LIFT_KG = 1000
MAX_DAY_VOLUME = 1_000_000
LIFT_ID_RE = re.compile(r"^[a-z0-9_]{1,40}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# В таблице users бот хранит цель/уровень буквами (из ссылки r_…), мини-апп — словами
GOAL_LETTERS = {"l": "lose", "m": "maintain", "g": "gain"}
LEVEL_LETTERS = {"b": "beginner", "i": "intermediate", "a": "advanced"}


# ── Мелочи ─────────────────────────────────────────────
def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def users_ts(dt: datetime) -> str:
    """Формат времени в таблице users (как в bot.py)."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def clean_num(x: float) -> int | float:
    """100.0 → 100, 102.456 → 102.46 — аккуратные числа в JSON."""
    x = round(float(x), 2)
    return int(x) if x.is_integer() else x


def fmt_num(x: float) -> str:
    """Число по-русски: 50000 → «50 000», 102.5 → «102,5»."""
    x = clean_num(x)
    if isinstance(x, int):
        return f"{x:,}".replace(",", " ")
    whole, frac = f"{x:.2f}".rstrip("0").split(".")
    return f"{int(whole):,}".replace(",", " ") + "," + frac


def plural(n: float, one: str, few: str, many: str) -> str:
    n = abs(int(n)) % 100
    if 10 < n < 20:
        return many
    n %= 10
    return one if n == 1 else few if 2 <= n <= 4 else many


def make_title(kind: str, exercise: str, target: float, days: int) -> str:
    if kind == "lift":
        return f"{LIFT_EXERCISES[exercise]} — {fmt_num(target)} кг"
    period = f"за {days} {plural(days, 'день', 'дня', 'дней')}"
    if kind == "workouts":
        return f"{int(target)} {plural(target, 'тренировка', 'тренировки', 'тренировок')} {period}"
    return f"{fmt_num(target)} кг объёма {period}"


def parse_day(value: str) -> date | None:
    if not isinstance(value, str) or not DATE_RE.match(value):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


class ApiError(Exception):
    def __init__(self, status: int, message: str, headers: dict | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.headers = headers or {}


def bad(message: str) -> ApiError:
    return ApiError(400, message)


# ── Подпись Telegram initData ──────────────────────────
def check_init_data(init_data: str, token: str, now: float | None = None) -> dict:
    """Проверяет Telegram.WebApp.initData и возвращает user. Иначе ApiError(401)."""
    denied = ApiError(401, "Не получилось проверить вход. Открой приложение из Telegram")
    if not init_data or not token or len(init_data) > 8192:
        raise denied
    pairs = parse_qsl(init_data, keep_blank_values=True)
    keys = [k for k, _ in pairs]
    if len(keys) != len(set(keys)):
        raise denied
    params = dict(pairs)
    received = params.pop("hash", "")
    if not received:
        raise denied
    dcs = "\n".join(f"{k}={v}" for k, v in sorted(params.items()))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    expected = hmac.new(secret, dcs.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected.encode(), received.encode()):
        raise denied
    try:
        auth_date = int(params.get("auth_date", ""))
    except ValueError:
        raise denied from None
    now = time.time() if now is None else now
    if auth_date > now + INIT_FUTURE_SKEW:
        raise denied
    if now - auth_date > INIT_MAX_AGE:
        raise ApiError(401, "Сессия устарела — закрой и снова открой приложение")
    try:
        user = json.loads(params.get("user", ""))
    except (ValueError, RecursionError):
        raise denied from None
    uid = user.get("id") if isinstance(user, dict) else None
    if not isinstance(uid, int) or isinstance(uid, bool) or uid <= 0:
        raise denied
    text = lambda v, n: v[:n] if isinstance(v, str) else ""  # noqa: E731
    return {
        "id": uid,
        "name": text(user.get("first_name"), 64).strip() or text(user.get("username"), 32) or "Атлет",
        "username": text(user.get("username"), 32),
    }


# ── Проверка тела /api/sync ────────────────────────────
def _number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _soft(v: Any, lo: float, hi: float, integer: bool = False) -> int | float | None:
    """Мягкая проверка полей анкеты: неверное значение просто не сохраняем."""
    if not _number(v) or not lo <= v <= hi:
        return None
    return int(round(v)) if integer else clean_num(v)


def validate_sync(data: Any, today: date) -> dict:
    """Код 400 — только для структуры (неверный тип поля, слишком много записей).
    Отдельные значения проверяются мягко: кривое (опечатка в весе, дата со сбитых часов)
    просто не сохраняется — иначе одна запись навсегда ломала бы всю синхронизацию."""
    if not isinstance(data, dict):
        raise bad("Ожидался JSON-объект")
    profile, stats, lifts, hist = (data.get(k) for k in ("profile", "stats", "lifts", "hist"))
    for name, value, kind in (("profile", profile, dict), ("stats", stats, dict), ("lifts", lifts, dict), ("hist", hist, list)):
        if value is not None and not isinstance(value, kind):
            raise bad(f"Поле {name} неверного типа")
    profile, stats, lifts, hist = profile or {}, stats or {}, lifts or {}, hist or []
    if len(lifts) > MAX_LIFTS:
        raise bad("Слишком много упражнений в lifts")
    if len(hist) > MAX_HIST:
        raise bad(f"В hist больше {MAX_HIST} записей")

    p = {
        "sex": profile.get("sex") if profile.get("sex") in SEXES else None,
        "age": _soft(profile.get("age"), 10, 100, True),
        "height": _soft(profile.get("height"), 100, 250),
        "weight": _soft(profile.get("weight"), 25, 350),
        "goal": profile.get("goal") if profile.get("goal") in GOALS else None,
        "level": profile.get("level") if profile.get("level") in LEVELS else None,
        "days": None,
    }
    days = profile.get("days")
    if isinstance(days, list) and len(days) <= 7 and all(isinstance(d, int) and not isinstance(d, bool) and 1 <= d <= 7 for d in days):
        p["days"] = sorted(set(days))

    s = {}
    for key, hi in STAT_LIMITS.items():
        v = _soft(stats.get(key), 0, hi, integer=key != "volume")
        if v is not None:
            s[key] = v

    skipped = 0
    lf = {}
    for key, value in lifts.items():
        if value is None:
            continue
        if LIFT_ID_RE.match(key) and _number(value) and 0 <= value <= MAX_LIFT_KG:
            lf[key] = clean_num(value)
        else:
            skipped += 1

    hs = []
    limit = today + timedelta(days=1)
    for item in hist:
        if not isinstance(item, list) or not 1 <= len(item) <= 5:
            skipped += 1
            continue
        day = parse_day(item[0])
        vol = item[1] if len(item) > 1 else 0
        vol = 0 if vol is None else vol
        if day is None or day.year < 2000 or day > limit or not _number(vol) or not 0 <= vol <= MAX_DAY_VOLUME:
            skipped += 1
            continue
        hs.append([item[0], clean_num(vol)])
    if skipped:
        log.info("sync: пропущено неверных записей lifts/hist: %s", skipped)
    # Обрезана ли история на клиенте — по числу присланных записей, а не прошедших проверку
    return {"profile": p, "stats": s, "lifts": lf, "hist": hs, "hist_truncated": len(hist) >= HIST_CLIENT_CAP}


def cap_per_day(hist: list) -> list:
    """Не больше MAX_PER_DAY тренировок за одну дату (порядок сохраняется)."""
    seen: dict[str, int] = {}
    out = []
    for item in hist:
        seen[item[0]] = seen.get(item[0], 0) + 1
        if seen[item[0]] <= MAX_PER_DAY:
            out.append(item)
    return out


def merge_hist(prev: list, new: list, today: date, truncated: bool | None = None) -> list:
    """Мини-апп хранит только 60 последних тренировок. Если пришло столько (история обрезана),
    более старые записи берём из сохранённой копии — иначе челлендж «70 тренировок» недостижим.
    Если пришло меньше — у клиента вся история (в т. ч. после сброса), заменяем целиком."""
    new = sorted(new, key=lambda h: h[0])
    if truncated is None:
        truncated = len(new) >= HIST_CLIENT_CAP
    if truncated and new and prev:
        first = new[0][0]
        prev = sorted((h for h in prev if isinstance(h, list) and len(h) >= 2 and isinstance(h[0], str)), key=lambda h: h[0])
        older = [h for h in prev if h[0] < first]
        # На первой дате клиент мог отрезать часть тренировок — добираем недостающие
        same_prev = [h for h in prev if h[0] == first]
        same_new = sum(1 for h in new if h[0] == first)
        new = older + same_prev[:max(0, len(same_prev) - same_new)] + new
    since = (today - timedelta(days=HIST_KEEP_DAYS)).isoformat()
    return cap_per_day([h for h in new if h[0] >= since])[-MAX_HIST:]


def validate_challenge(data: Any) -> dict:
    if not isinstance(data, dict):
        raise bad("Ожидался JSON-объект")
    kind = data.get("type")
    if kind not in TYPES:
        raise bad("Неизвестный тип челленджа")
    (t_lo, t_hi), (d_lo, d_hi), integer = TYPES[kind]
    exercise = ""
    if kind == "lift":
        exercise = data.get("exercise")
        if exercise not in LIFT_EXERCISES:
            raise bad("Выбери упражнение из списка")
    target = data.get("target")
    if not _number(target) or not t_lo <= target <= t_hi:
        raise bad(f"Цель — от {fmt_num(t_lo)} до {fmt_num(t_hi)}")
    if integer and float(target) != int(target):
        raise bad("Цель должна быть целым числом")
    days = data.get("days")
    if days is None:
        if kind != "lift":
            raise bad("Укажи срок в днях")
        days = 0
    if not _number(days) or float(days) != int(days) or not d_lo <= days <= d_hi:
        raise bad(f"Срок — от {d_lo} до {d_hi} дней")
    target = int(target) if integer else clean_num(target)
    return {"type": kind, "exercise": exercise, "target": target, "days": int(days)}


# ── База ───────────────────────────────────────────────
@dataclass
class Event:
    kind: str  # joined | winner | finished
    code: str
    user: dict | None = None  # для joined — кто вступил


class Store:
    """Таблицы мини-аппа в той же базе, что и бот (таблица users — общая)."""

    def __init__(self, conn: sqlite3.Connection, clock: Callable[[], datetime] = utcnow):
        self.conn = conn
        self.conn.row_factory = sqlite3.Row
        self.clock = clock
        self.migrate()

    # Миграции — идемпотентные: таблицы и недостающие колонки
    SCHEMA = {
        "users": {
            "id": "INTEGER PRIMARY KEY", "name": "TEXT DEFAULT ''", "username": "TEXT DEFAULT ''",
            "blocked": "INTEGER DEFAULT 0", "first_seen": "TEXT DEFAULT ''", "last_seen": "TEXT DEFAULT ''",
        },
        "app_stats": {
            "user_id": "INTEGER PRIMARY KEY", "profile": "TEXT DEFAULT '{}'", "stats": "TEXT DEFAULT '{}'",
            "lifts": "TEXT DEFAULT '{}'", "hist": "TEXT DEFAULT '[]'", "updated_at": "TEXT DEFAULT ''",
        },
        "challenges": {
            "id": "INTEGER PRIMARY KEY AUTOINCREMENT", "code": "TEXT NOT NULL UNIQUE", "type": "TEXT NOT NULL",
            "exercise": "TEXT DEFAULT ''", "target": "REAL NOT NULL", "days": "INTEGER DEFAULT 0",
            "title": "TEXT DEFAULT ''", "created_by": "INTEGER NOT NULL", "created_at": "TEXT NOT NULL",
            "starts_on": "TEXT NOT NULL", "ends_on": "TEXT", "status": "TEXT DEFAULT 'active'",
            "winner_id": "INTEGER", "finished_at": "TEXT",
        },
        "participants": {
            "challenge_id": "INTEGER NOT NULL", "user_id": "INTEGER NOT NULL", "joined_at": "TEXT NOT NULL",
            "progress": "REAL DEFAULT 0", "reached_at": "TEXT",
            # Вышел из челленджа (строка остаётся, чтобы повторное вступление не рассылало «принял вызов»)
            "left_at": "TEXT",
        },
    }
    TABLE_EXTRA = {"participants": ", PRIMARY KEY (challenge_id, user_id)"}

    def migrate(self) -> None:
        c = self.conn
        for table, cols in self.SCHEMA.items():
            ddl = ", ".join(f"{k} {v}" for k, v in cols.items()) + self.TABLE_EXTRA.get(table, "")
            c.execute(f"CREATE TABLE IF NOT EXISTS {table} ({ddl})")
            have = {r[1] for r in c.execute(f"PRAGMA table_info({table})")}
            for col, spec in cols.items():
                if col not in have:
                    # ALTER не умеет PRIMARY KEY/UNIQUE/NOT NULL без значения — добавляем как обычную колонку
                    plain = re.sub(r"PRIMARY KEY|AUTOINCREMENT|UNIQUE|NOT NULL", "", spec).strip() or "TEXT"
                    c.execute(f"ALTER TABLE {table} ADD COLUMN {col} {plain}")
        c.execute("CREATE INDEX IF NOT EXISTS idx_participants_user ON participants (user_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_challenges_status ON challenges (status, ends_on)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_challenges_creator ON challenges (created_by, status)")
        c.commit()

    def now(self) -> datetime:
        return self.clock()

    # Пользователи
    def touch_user(self, user: dict) -> None:
        ts = users_ts(self.now())
        self.conn.execute(
            """INSERT INTO users (id, name, username, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET name = excluded.name, username = excluded.username,
                 last_seen = excluded.last_seen,
                 first_seen = CASE WHEN users.first_seen = '' THEN excluded.first_seen ELSE users.first_seen END""",
            (user["id"], user["name"], user["username"], ts, ts),
        )
        self.conn.commit()

    def user_sex(self, uid: int) -> str:
        row = self.conn.execute("SELECT profile FROM app_stats WHERE user_id = ?", (uid,)).fetchone()
        if row:
            sex = _loads(row["profile"], {}).get("sex")
            if sex in SEXES:
                return sex
        row = self.conn.execute("SELECT sex FROM users WHERE id = ?", (uid,)).fetchone() if self._has_col("users", "sex") else None
        return row["sex"] if row and row["sex"] in SEXES else ""

    def _has_col(self, table: str, col: str) -> bool:
        return any(r[1] == col for r in self.conn.execute(f"PRAGMA table_info({table})"))

    # Сводка
    def save_sync(self, uid: int, data: dict) -> None:
        dump = lambda v: json.dumps(v, ensure_ascii=False, separators=(",", ":"))  # noqa: E731
        row = self.conn.execute("SELECT hist FROM app_stats WHERE user_id = ?", (uid,)).fetchone()
        hist = merge_hist(_loads(row["hist"], []) if row else [], data["hist"], self.now().date(),
                          data.get("hist_truncated"))
        self.conn.execute(
            """INSERT INTO app_stats (user_id, profile, stats, lifts, hist, updated_at) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(user_id) DO UPDATE SET profile = excluded.profile, stats = excluded.stats,
                 lifts = excluded.lifts, hist = excluded.hist, updated_at = excluded.updated_at""",
            (uid, dump(data["profile"]), dump(data["stats"]), dump(data["lifts"]), dump(hist), iso(self.now())),
        )
        self.conn.commit()

    # Челленджи
    def challenge(self, code: str) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM challenges WHERE code = ?", (code,)).fetchone()

    def _count(self, sql: str, *args) -> int:
        return self.conn.execute(sql, args).fetchone()[0] or 0

    def active_count(self, uid: int) -> int:
        """Активные челленджи, где человек участвует сейчас (в т. ч. созданные им)."""
        return self._count(
            "SELECT COUNT(*) FROM participants p JOIN challenges c ON c.id = p.challenge_id "
            "WHERE p.user_id = ? AND p.left_at IS NULL AND c.status = 'active'", uid)

    def members_count(self, ch: sqlite3.Row) -> int:
        return self._count("SELECT COUNT(*) FROM participants WHERE challenge_id = ? AND left_at IS NULL", ch["id"])

    def _new_code(self) -> str:
        for _ in range(50):
            code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LEN))
            if not self.challenge(code):
                return code
        raise ApiError(503, "Не получилось создать код — попробуй ещё раз")

    def create_challenge(self, uid: int, spec: dict) -> tuple[sqlite3.Row, list[Event]]:
        # Считаем только те, где создатель ещё участвует: из которых вышел — не держат лимит
        if self.active_count(uid) >= MAX_ACTIVE:
            raise bad(f"У тебя уже {MAX_ACTIVE} активных челленджей — заверши или выйди из какого-нибудь")
        now = self.now()
        if self._count("SELECT COUNT(*) FROM challenges WHERE created_by = ? AND created_at > ?",
                       uid, iso(now - timedelta(days=1))) >= MAX_CREATED_PER_DAY:
            raise bad(f"За сутки можно создать не больше {MAX_CREATED_PER_DAY} челленджей — попробуй завтра")
        start = now.date()
        ends = start + timedelta(days=spec["days"] - 1) if spec["days"] else None
        mine = self._progress_of(uid, spec["type"], spec["exercise"], start.isoformat(),
                                 ends.isoformat() if ends else None, start)
        if mine >= spec["target"]:
            # Иначе челлендж закончится победой создателя в ту же секунду
            have = {
                "lift": f"Твой рекорд уже {fmt_num(mine)} кг",
                "workouts": f"Сегодня у тебя уже {fmt_num(mine)} {plural(mine, 'тренировка', 'тренировки', 'тренировок')}",
                "volume": f"Сегодня у тебя уже {fmt_num(mine)} кг объёма",
            }[spec["type"]]
            raise bad(f"{have} — поставь цель выше")
        title = make_title(spec["type"], spec["exercise"], spec["target"], spec["days"])
        code = self._new_code()
        self.conn.execute(
            """INSERT INTO challenges (code, type, exercise, target, days, title, created_by, created_at,
                 starts_on, ends_on, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')""",
            (code, spec["type"], spec["exercise"], spec["target"], spec["days"], title, uid, iso(now),
             start.isoformat(), ends.isoformat() if ends else None),
        )
        ch = self.challenge(code)
        self.conn.execute(
            "INSERT INTO participants (challenge_id, user_id, joined_at, progress) VALUES (?, ?, ?, 0)",
            (ch["id"], uid, iso(now)),
        )
        self.conn.commit()
        events = self.recompute(ch)
        return self.challenge(code), events

    def is_member(self, ch: sqlite3.Row, uid: int) -> bool:
        return bool(self._count(
            "SELECT COUNT(*) FROM participants WHERE challenge_id = ? AND user_id = ? AND left_at IS NULL", ch["id"], uid))

    def _expired(self, ch: sqlite3.Row) -> bool:
        return bool(ch["ends_on"]) and self.now().date().isoformat() > ch["ends_on"]

    def join(self, ch: sqlite3.Row, user: dict) -> list[Event]:
        """Вступить. «X принял вызов» — только при самом первом вступлении: повторное после выхода
        тихое, иначе цикл «вышел — вступил» рассылал бы уведомления всем участникам."""
        uid = user["id"]
        ch = self.challenge(ch["code"])  # свежая строка
        if self.is_member(ch, uid):
            return self.recompute(ch)
        # Срок вышел, а планировщик ещё не закрыл — новичок не должен попасть в итоги
        if ch["status"] != "active" or self._expired(ch):
            raise bad("Челлендж уже завершён")
        if self.members_count(ch) >= MAX_PARTICIPANTS:
            raise bad(f"Мест нет — уже {MAX_PARTICIPANTS} участников")
        if self.active_count(uid) >= MAX_ACTIVE:
            raise bad(f"У тебя уже {MAX_ACTIVE} активных челленджей — заверши или выйди из какого-нибудь")
        now = iso(self.now())
        cur = self.conn.execute(
            "UPDATE participants SET left_at = NULL, joined_at = ?, progress = 0, reached_at = NULL "
            "WHERE challenge_id = ? AND user_id = ?", (now, ch["id"], uid))
        rejoined = cur.rowcount == 1
        if not rejoined:
            self.conn.execute(
                "INSERT INTO participants (challenge_id, user_id, joined_at, progress) VALUES (?, ?, ?, 0)",
                (ch["id"], uid, now),
            )
        self.conn.commit()
        events = self.recompute(ch)
        return events if rejoined else [Event("joined", ch["code"], user), *events]

    def leave(self, ch: sqlite3.Row, uid: int) -> None:
        ch = self.challenge(ch["code"])
        if not self.is_member(ch, uid):
            raise bad("Ты не участвуешь в этом челлендже")
        if ch["status"] != "active":
            raise bad("Челлендж уже завершён")
        self.conn.execute(
            "UPDATE participants SET left_at = ? WHERE challenge_id = ? AND user_id = ?", (iso(self.now()), ch["id"], uid))
        if not self.members_count(ch):
            if self._count("SELECT COUNT(*) FROM participants WHERE challenge_id = ?", ch["id"]) == 1:
                # Создатель передумал, а больше никто не вступал — удаляем без следа
                self.conn.execute("DELETE FROM participants WHERE challenge_id = ?", (ch["id"],))
                self.conn.execute("DELETE FROM challenges WHERE id = ?", (ch["id"],))
            else:
                # Ушли все — закрываем без победителя, чтобы не висел вечно
                self.conn.execute(
                    "UPDATE challenges SET status = 'finished', finished_at = ? WHERE id = ? AND status = 'active'",
                    (iso(self.now()), ch["id"]),
                )
        self.conn.commit()

    def user_challenges(self, uid: int) -> list[sqlite3.Row]:
        mine = "FROM challenges c JOIN participants p ON p.challenge_id = c.id WHERE p.user_id = ? AND p.left_at IS NULL"
        active = self.conn.execute(
            f"SELECT c.* {mine} AND c.status = 'active' ORDER BY c.created_at DESC, c.id DESC", (uid,)).fetchall()
        done = self.conn.execute(
            f"SELECT c.* {mine} AND c.status != 'active' ORDER BY c.finished_at DESC, c.id DESC LIMIT ?",
            (uid, FINISHED_IN_LIST)).fetchall()
        return [*active, *done]

    # Прогресс и победитель
    def _progress_of(self, uid, kind, exercise, starts_on, ends_on, today) -> float:
        row = self.conn.execute("SELECT lifts, hist FROM app_stats WHERE user_id = ?", (uid,)).fetchone()
        if not row:
            return 0
        return self._progress(kind, exercise, starts_on, ends_on, row["lifts"], row["hist"], today)

    @staticmethod
    def _progress(kind, exercise, starts_on, ends_on, lifts_json, hist_json, today: date) -> float:
        if kind == "lift":
            v = _loads(lifts_json, {}).get(exercise, 0)
            return float(v) if _number(v) else 0.0
        start = starts_on or "0000-00-00"
        end = min(ends_on or "9999-99-99", (today + timedelta(days=1)).isoformat())
        hist = [h for h in _loads(hist_json, []) if isinstance(h, list) and h and isinstance(h[0], str)]
        total = 0.0
        for item in cap_per_day(hist):  # не больше 3 тренировок за дату — и для старых записей в базе
            if start <= item[0] <= end:
                if kind == "workouts":
                    total += 1
                elif len(item) > 1 and _number(item[1]):
                    total += item[1]
        return total

    def recompute(self, ch: sqlite3.Row) -> list[Event]:
        """Пересчитать прогресс участников, зафиксировать победителя (один раз) или итоги по сроку."""
        ch = self.challenge(ch["code"])  # свежая строка
        if not ch or ch["status"] != "active":
            return []
        now = self.now()
        now_s, today = iso(now), now.date()
        expired = bool(ch["ends_on"]) and today.isoformat() > ch["ends_on"]
        rows = self.conn.execute(
            "SELECT p.user_id, p.joined_at, p.reached_at, a.lifts, a.hist, a.updated_at FROM participants p "
            "LEFT JOIN app_stats a ON a.user_id = p.user_id WHERE p.challenge_id = ? AND p.left_at IS NULL",
            (ch["id"],)).fetchall()
        if not rows:
            return []
        for r in rows:
            progress = self._progress(ch["type"], ch["exercise"], ch["starts_on"], ch["ends_on"], r["lifts"], r["hist"], today)
            reached = r["reached_at"]
            if reached is None and not expired and progress >= ch["target"]:
                # Момент, когда пришли данные с рекордом, но не раньше вступления
                reached = min(max(r["updated_at"] or now_s, r["joined_at"]), now_s)
            self.conn.execute(
                "UPDATE participants SET progress = ?, reached_at = ? WHERE challenge_id = ? AND user_id = ?",
                (clean_num(progress), reached, ch["id"], r["user_id"]),
            )
        events: list[Event] = []
        first = self.conn.execute(
            "SELECT user_id FROM participants WHERE challenge_id = ? AND left_at IS NULL AND reached_at IS NOT NULL "
            "ORDER BY reached_at, joined_at LIMIT 1", (ch["id"],)).fetchone()
        if first and self._finish(ch["id"], first["user_id"], now_s):
            events.append(Event("winner", ch["code"]))
        elif expired:
            leader = self.conn.execute(
                "SELECT user_id FROM participants WHERE challenge_id = ? AND left_at IS NULL AND progress > 0 "
                "ORDER BY progress DESC, joined_at LIMIT 1", (ch["id"],)).fetchone()
            if self._finish(ch["id"], leader["user_id"] if leader else None, now_s):
                events.append(Event("finished", ch["code"]))
        self.conn.commit()
        return events

    def _finish(self, cid: int, winner: int | None, now_s: str) -> bool:
        cur = self.conn.execute(
            "UPDATE challenges SET status = 'finished', winner_id = ?, finished_at = ? WHERE id = ? AND status = 'active'",
            (winner, now_s, cid),
        )
        return cur.rowcount == 1

    def recompute_for_user(self, uid: int) -> list[Event]:
        rows = self.conn.execute(
            "SELECT c.* FROM challenges c JOIN participants p ON p.challenge_id = c.id "
            "WHERE p.user_id = ? AND p.left_at IS NULL AND c.status = 'active'", (uid,)).fetchall()
        return [e for ch in rows for e in self.recompute(ch)]

    def finish_expired(self) -> list[Event]:
        today = self.now().date().isoformat()
        rows = self.conn.execute(
            "SELECT * FROM challenges WHERE status = 'active' AND ends_on IS NOT NULL AND ends_on < ?", (today,)).fetchall()
        return [e for ch in rows for e in self.recompute(ch)]

    # Ответ API
    def challenge_dict(self, ch: sqlite3.Row, viewer: int | None = None, bot_username: str = "") -> dict:
        rows = self.conn.execute(
            "SELECT p.user_id, p.joined_at, p.progress, p.reached_at, u.name, u.username FROM participants p "
            "LEFT JOIN users u ON u.id = p.user_id WHERE p.challenge_id = ? AND p.left_at IS NULL", (ch["id"],)).fetchall()
        # Победитель — первым, дальше по убыванию прогресса
        rows = sorted(rows, key=lambda r: (r["user_id"] != ch["winner_id"], -(r["progress"] or 0),
                                           r["reached_at"] or "~", r["joined_at"]))
        participants = [{
            "id": r["user_id"], "name": r["name"] or "Атлет", "username": r["username"] or "",
            "progress": clean_num(r["progress"] or 0), "reached_at": r["reached_at"], "is_me": r["user_id"] == viewer,
        } for r in rows]
        winner = None
        if ch["winner_id"]:
            w = self.conn.execute("SELECT name FROM users WHERE id = ?", (ch["winner_id"],)).fetchone()
            winner = {"id": ch["winner_id"], "name": (w["name"] if w else "") or "Атлет"}
        mine = next((p["progress"] for p in participants if p["is_me"]), None)
        return {
            "code": ch["code"], "type": ch["type"], "exercise": ch["exercise"] or None,
            "exercise_name": LIFT_EXERCISES.get(ch["exercise"] or "", None),
            "target": clean_num(ch["target"]), "days": ch["days"], "title": ch["title"],
            "created_by": ch["created_by"], "created_at": ch["created_at"],
            "starts_on": ch["starts_on"], "ends_on": ch["ends_on"],
            "status": ch["status"], "finished_at": ch["finished_at"], "winner": winner,
            "participants": participants, "my_progress": mine,
            "invite_link": f"https://t.me/{bot_username}?start=ch_{ch['code']}" if bot_username else "",
        }

    def notifications(self, events: list[Event], bot_username: str = "") -> list[tuple[str, dict, dict | None]]:
        out = []
        for ev in events:
            ch = self.challenge(ev.code)
            if ch:
                out.append((ev.kind, self.challenge_dict(ch, None, bot_username), ev.user))
        return out

    # Статистика для админа
    def admin_stats(self) -> dict:
        now = self.now()
        since = lambda d: users_ts(now - timedelta(days=d))  # noqa: E731
        q = self._count
        goals = dict.fromkeys(GOALS, 0)
        levels = dict.fromkeys(LEVELS, 0)
        sexes = dict.fromkeys(SEXES, 0)
        has = {c: self._has_col("users", c) for c in ("goal", "level", "sex")}
        cols = ", ".join(f"u.{c}" if has[c] else f"'' AS {c}" for c in ("goal", "level", "sex"))
        workouts = synced = 0
        for r in self.conn.execute(
            f"SELECT {cols}, a.user_id AS synced, a.profile, a.stats, a.hist FROM users u "
            "LEFT JOIN app_stats a ON a.user_id = u.id"
        ):
            p = _loads(r["profile"], {}) if r["synced"] else {}
            goal = p.get("goal") or GOAL_LETTERS.get(r["goal"] or "")
            level = p.get("level") or LEVEL_LETTERS.get(r["level"] or "")
            sex = p.get("sex") or r["sex"]
            if goal in goals:
                goals[goal] += 1
            if level in levels:
                levels[level] += 1
            if sex in sexes:
                sexes[sex] += 1
            if r["synced"]:
                synced += 1
                st = _loads(r["stats"], {})
                n = st.get("workouts")
                n = n if _number(n) and n >= 0 else len(_loads(r["hist"], []))
                workouts += min(int(n), STAT_LIMITS["workouts"])  # и для записей до ограничений
        by_day = dict(self.conn.execute(
            "SELECT substr(first_seen, 1, 10) AS d, COUNT(*) FROM users WHERE first_seen >= ? GROUP BY d",
            (users_ts(now - timedelta(days=30)),)).fetchall())
        days = [(now.date() - timedelta(days=i)).isoformat() for i in range(29, -1, -1)]
        return {
            "users_total": q("SELECT COUNT(*) FROM users"),
            "users_new_7d": q("SELECT COUNT(*) FROM users WHERE first_seen >= ?", since(7)),
            "active_7d": q("SELECT COUNT(*) FROM users WHERE last_seen >= ?", since(7)),
            "synced_users": synced,
            "workouts_total": workouts,
            "challenges_active": q("SELECT COUNT(*) FROM challenges WHERE status = 'active'"),
            "challenges_finished": q("SELECT COUNT(*) FROM challenges WHERE status != 'active'"),
            "challenge_participants": q(
                "SELECT COUNT(DISTINCT p.user_id) FROM participants p JOIN challenges c ON c.id = p.challenge_id "
                "WHERE p.left_at IS NULL"),
            "goals": goals, "levels": levels, "sexes": sexes,
            "new_by_day": [[d, by_day.get(d, 0)] for d in days],
        }


def _loads(raw: str | None, default):
    try:
        v = json.loads(raw) if raw else default
    except ValueError:
        return default
    return v if isinstance(v, type(default)) else default


# ── Уведомления ────────────────────────────────────────
class Notifier:
    """Интерфейс уведомлений. Бот (bot.py) реализует его отправкой сообщений в Telegram.
    ch — словарь челленджа как в ответе API (viewer = None), user — {id, name, username}."""

    async def joined(self, ch: dict, user: dict) -> None: ...

    async def winner(self, ch: dict) -> None: ...

    async def finished(self, ch: dict) -> None: ...


async def deliver(notifier: Notifier | None, prepared: list[tuple[str, dict, dict | None]]) -> None:
    if not notifier:
        return
    for kind, ch, user in prepared:
        try:
            if kind == "joined":
                await notifier.joined(ch, user)
            else:
                await getattr(notifier, kind)(ch)
        except Exception:  # noqa: BLE001 — уведомления не должны ронять API
            log.exception("notify %s %s failed", kind, ch.get("code"))


# ── Ограничение частоты ────────────────────────────────
class RateLimiter:
    def __init__(self, limit: int = RATE_LIMIT, window: float = 60.0, clock: Callable[[], float] = time.monotonic):
        self.limit, self.window, self.clock = limit, window, clock
        self.hits: dict[int, deque] = {}

    def hit(self, key: int) -> float:
        """0 — можно; иначе — через сколько секунд повторить."""
        now = self.clock()
        if len(self.hits) > 10_000:
            self.hits = {k: q for k, q in self.hits.items() if q and q[-1] > now - self.window}
        q = self.hits.setdefault(key, deque())
        while q and q[0] <= now - self.window:
            q.popleft()
        if len(q) >= self.limit:
            return max(1.0, q[0] + self.window - now)
        q.append(now)
        return 0.0


# ── HTTP-приложение ────────────────────────────────────
@dataclass
class ApiConfig:
    token: str
    admin_ids: set[int] = field(default_factory=set)
    origins: set[str] = field(default_factory=lambda: {DEFAULT_ORIGINS})
    bot_username: str = ""
    rate_limit: int = RATE_LIMIT


def parse_origins(raw: str | None, dev: bool = False) -> set[str]:
    items = (raw if raw and raw.strip() else DEFAULT_ORIGINS).split(",")
    origins = {o.strip().rstrip("/") for o in items if o.strip()}
    if dev:
        origins.update(DEV_ORIGINS)
    return origins


STORE = web.AppKey("store", Store)
CONFIG = web.AppKey("config", ApiConfig)
NOTIFIER = web.AppKey("notifier", object)
LIMITER = web.AppKey("limiter", RateLimiter)
TASKS = web.AppKey("tasks", set)
# Пользователь из initData, проверенный auth_middleware (RequestKey — с aiohttp 3.13)
USER = web.RequestKey("user", dict) if hasattr(web, "RequestKey") else "user"

CORS_HEADERS = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Init-Data",
    "Access-Control-Max-Age": "86400",
}
HTTP_MESSAGES = {
    404: "Не найдено", 405: "Метод не поддерживается", 413: "Слишком большой запрос",
}


def dumps(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def reply(data: Any, status: int = 200, headers: dict | None = None) -> web.Response:
    return web.json_response(data, status=status, headers=headers, dumps=dumps)


def json_error(status: int, message: str, headers: dict | None = None) -> web.Response:
    return reply({"error": message}, status, headers)


@web.middleware
async def cors_middleware(request: web.Request, handler) -> web.StreamResponse:
    origin = request.headers.get("Origin", "")
    allowed = bool(origin) and origin in request.app[CONFIG].origins
    if request.method == "OPTIONS":
        resp = web.Response(status=204, headers=CORS_HEADERS) if allowed else json_error(403, "Источник запроса не разрешён")
    elif origin and not allowed:
        resp = json_error(403, "Источник запроса не разрешён")
    else:
        try:
            resp = await handler(request)
        except ApiError as e:
            resp = json_error(e.status, e.message, e.headers)
        except web.HTTPException as e:
            if e.status < 400:
                raise
            resp = json_error(e.status, HTTP_MESSAGES.get(e.status, e.reason or "Ошибка"))
        except Exception:  # noqa: BLE001
            log.exception("API %s %s failed", request.method, request.path)
            resp = json_error(500, "Ошибка сервера — попробуй позже")
    if allowed:
        resp.headers["Access-Control-Allow-Origin"] = origin
    resp.headers["Vary"] = "Origin"
    resp.headers.setdefault("Cache-Control", "no-store")
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    return resp


PUBLIC_PATHS = {"/api/health"}


@web.middleware
async def auth_middleware(request: web.Request, handler) -> web.StreamResponse:
    if request.path in PUBLIC_PATHS or request.match_info.http_exception is not None:
        return await handler(request)
    app = request.app
    user = check_init_data(request.headers.get("X-Init-Data", ""), app[CONFIG].token)
    wait = app[LIMITER].hit(user["id"])
    if wait:
        raise ApiError(429, "Слишком много запросов — подожди минуту", {"Retry-After": str(math.ceil(wait))})
    app[STORE].touch_user(user)
    request[USER] = user
    return await handler(request)


async def read_json(request: web.Request) -> Any:
    if (request.content_length or 0) > MAX_BODY:
        raise ApiError(413, "Слишком большой запрос")
    raw = await request.read()  # client_max_size тоже ограничивает тело
    if not raw.strip():
        raise bad("Пустой запрос")

    def no_constants(name):
        raise ValueError(name)

    try:
        return json.loads(raw.decode("utf-8"), parse_constant=no_constants)
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise bad("Неверный JSON") from None


def spawn_notifications(app: web.Application, events: list[Event]) -> None:
    """Уведомления — в фоне, чтобы не задерживать ответ. Темп отправки ограничивает сам Notifier
    (бот: общий на весь процесс). Если очередь разрослась — «X принял вызов» не шлём, итоги шлём всегда."""
    if not events or app[NOTIFIER] is None:
        return
    if len(app[TASKS]) >= MAX_PENDING_NOTIFY:
        dropped = sum(e.kind == "joined" for e in events)
        events = [e for e in events if e.kind != "joined"]
        if dropped:
            log.warning("очередь уведомлений переполнена — пропущено «принял вызов»: %s", dropped)
        if not events:
            return
    prepared = app[STORE].notifications(events, app[CONFIG].bot_username)
    task = asyncio.create_task(deliver(app[NOTIFIER], prepared))
    app[TASKS].add(task)
    task.add_done_callback(app[TASKS].discard)


async def drain(app: web.Application, timeout: float = 10) -> None:
    """Дождаться отправки уведомлений (тесты, остановка сервера)."""
    tasks = list(app[TASKS])
    if tasks:
        _, pending = await asyncio.wait(tasks, timeout=timeout)
        for t in pending:
            t.cancel()


def get_challenge(request: web.Request) -> sqlite3.Row:
    code = request.match_info["code"].strip().upper()
    ch = request.app[STORE].challenge(code) if CODE_RE.match(code) else None
    if not ch:
        raise ApiError(404, "Челлендж не найден — проверь код")
    return ch


def out(request: web.Request, ch: sqlite3.Row) -> dict:
    store = request.app[STORE]
    return store.challenge_dict(store.challenge(ch["code"]), request[USER]["id"], request.app[CONFIG].bot_username)


async def health(request: web.Request) -> web.Response:
    return reply({"ok": True})


async def sync(request: web.Request) -> web.Response:
    store = request.app[STORE]
    data = validate_sync(await read_json(request), store.now().date())
    uid = request[USER]["id"]
    store.save_sync(uid, data)
    spawn_notifications(request.app, store.recompute_for_user(uid))
    return reply({"ok": True})


async def list_challenges(request: web.Request) -> web.Response:
    store, uid = request.app[STORE], request[USER]["id"]
    events = [e for ch in store.user_challenges(uid) if ch["status"] == "active" for e in store.recompute(ch)]
    spawn_notifications(request.app, events)
    return reply({"challenges": [out(request, ch) for ch in store.user_challenges(uid)]})


async def create_challenge(request: web.Request) -> web.Response:
    store = request.app[STORE]
    spec = validate_challenge(await read_json(request))
    ch, events = store.create_challenge(request[USER]["id"], spec)
    spawn_notifications(request.app, events)
    return reply({"challenge": out(request, ch)})


async def show_challenge(request: web.Request) -> web.Response:
    ch = get_challenge(request)
    spawn_notifications(request.app, request.app[STORE].recompute(ch))
    return reply({"challenge": out(request, ch)})


async def join_challenge(request: web.Request) -> web.Response:
    ch = get_challenge(request)
    store = request.app[STORE]
    # Сначала закрыть, если срок вышел, а планировщик ещё не успел: итоги уйдут, вступление — 400
    spawn_notifications(request.app, store.recompute(ch))
    spawn_notifications(request.app, store.join(ch, request[USER]))
    return reply({"challenge": out(request, ch)})


async def leave_challenge(request: web.Request) -> web.Response:
    ch = get_challenge(request)
    store = request.app[STORE]
    spawn_notifications(request.app, store.recompute(ch))  # выйти «после финиша» нельзя
    store.leave(ch, request[USER]["id"])
    return reply({"ok": True})


async def admin_stats(request: web.Request) -> web.Response:
    if request[USER]["id"] not in request.app[CONFIG].admin_ids:
        raise ApiError(403, "Нет доступа")
    return reply(request.app[STORE].admin_stats())


class AccessLogger(AbstractAccessLogger):
    """Короткий журнал запросов без /api/health (его дёргает HEALTHCHECK Docker каждые 30 с)."""

    def log(self, request: web.BaseRequest, response: web.StreamResponse, time: float) -> None:
        if request.path not in PUBLIC_PATHS:
            self.logger.info("%s %s → %s (%.0f мс)", request.method, request.path, response.status, time * 1000)


async def _on_cleanup(app: web.Application) -> None:
    await drain(app)


def create_app(store: Store, config: ApiConfig, notifier: Notifier | None = None) -> web.Application:
    app = web.Application(middlewares=[cors_middleware, auth_middleware], client_max_size=MAX_BODY)
    app[STORE] = store
    app[CONFIG] = config
    app[NOTIFIER] = notifier
    app[LIMITER] = RateLimiter(config.rate_limit)
    app[TASKS] = set()
    r = app.router
    r.add_get("/api/health", health)
    r.add_post("/api/sync", sync)
    r.add_get("/api/challenges", list_challenges)
    r.add_post("/api/challenges", create_challenge)
    r.add_get("/api/challenges/{code}", show_challenge)
    r.add_post("/api/challenges/{code}/join", join_challenge)
    r.add_post("/api/challenges/{code}/leave", leave_challenge)
    r.add_get("/api/admin/stats", admin_stats)
    app.on_cleanup.append(_on_cleanup)
    return app
