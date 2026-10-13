"""Тесты API мини-аппа и уведомлений бота (unittest + aiohttp TestServer, без pytest).

Запуск:  cd bot && python -m unittest discover -s tests -v
Бот в Telegram не ходит: вместо aiogram.Bot — заглушка, которая собирает сообщения.
"""

import hashlib
import hmac
import json
import os
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

TOKEN = "123456:TEST-token-for-unit-tests"
ADMIN = 1
TMP = tempfile.mkdtemp(prefix="gymapp-test-")
# До импорта bot.py: свои значения важнее bot/.env (load_env использует setdefault)
os.environ.update({
    "BOT_TOKEN": TOKEN, "DB_PATH": os.path.join(TMP, "import.db"), "ADMIN_IDS": str(ADMIN),
    "WEBAPP_URL": "https://zed0306.github.io/gymapp/", "PUBLIC_URL": "https://1-2-3-4.sslip.io/",
    "ALLOWED_ORIGINS": "", "DEV": "0", "BOT_USERNAME": "testbot", "API_PORT": "8080",
})
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aiogram.exceptions import TelegramForbiddenError  # noqa: E402
from aiogram.methods import SendMessage  # noqa: E402
from aiohttp.test_utils import TestClient, TestServer  # noqa: E402

import api  # noqa: E402
import bot as botmod  # noqa: E402

botmod.db.conn.close()  # база, созданная при импорте, не нужна: в каждом тесте — своя в памяти

ORIGIN = "https://zed0306.github.io"
NAMES = {1: "Админ", 2: "Ваня", 3: "Маша", 4: "Петя"}


def make_init(uid: int, token: str = TOKEN, auth_date: int | None = None, name: str | None = None, **extra) -> str:
    user = {"id": uid, "first_name": name or NAMES.get(uid, f"User{uid}"), "username": f"u{uid}", "language_code": "ru"}
    params = {
        "query_id": "AAHdF6IQAAAAAN0XohDhrOrc",
        "user": json.dumps(user, ensure_ascii=False, separators=(",", ":")),
        "auth_date": str(int(time.time()) if auth_date is None else auth_date),
        **extra,
    }
    dcs = "\n".join(f"{k}={v}" for k, v in sorted(params.items()))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    params["hash"] = hmac.new(secret, dcs.encode(), hashlib.sha256).hexdigest()
    return urlencode(params)


class FakeBot:
    """Вместо aiogram.Bot: собирает сообщения, для blocked кидает TelegramForbiddenError."""

    def __init__(self):
        self.sent: list[tuple[int, str, object]] = []
        self.blocked: set[int] = set()

    async def send_message(self, chat_id, text, reply_markup=None, **kw):
        if chat_id in self.blocked:
            raise TelegramForbiddenError(SendMessage(chat_id=chat_id, text=text), "Forbidden: bot was blocked by the user")
        self.sent.append((chat_id, text, reply_markup))
        return True

    def to(self, uid: int) -> list[str]:
        return [t for c, t, _ in self.sent if c == uid]


class FakeUser:
    def __init__(self, uid: int):
        self.id = uid
        self.first_name = NAMES.get(uid, f"User{uid}")
        self.username = f"u{uid}"


class FakeMessage:
    def __init__(self, uid: int):
        self.from_user = FakeUser(uid)
        self.answers: list[tuple[str, object]] = []

    async def answer(self, text, reply_markup=None, **kw):
        self.answers.append((text, reply_markup))


def sync_body(lifts=None, hist=None, **profile) -> dict:
    p = {"sex": "m", "age": 30, "height": 180, "weight": 82.5, "goal": "gain", "level": "beginner", "days": [1, 3, 5]}
    p.update(profile)
    return {"profile": p, "stats": {"workouts": len(hist or []), "volume": 1000, "prs": 1, "streak": 2},
            "lifts": lifts or {}, "hist": hist or []}


class ApiTestCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.db = botmod.DB(":memory:")
        self.store = api.Store(self.db.conn)
        botmod.db, botmod.store = self.db, self.store  # уведомления бота работают с той же базой
        self.tg = FakeBot()
        botmod.THROTTLE = botmod.Throttle(0)  # в тестах — без пауз между сообщениями
        self.notifier = botmod.TelegramNotifier(self.tg)
        self.config = api.ApiConfig(token=TOKEN, admin_ids={ADMIN}, origins=api.parse_origins(None), bot_username="testbot")
        self.app = api.create_app(self.store, self.config, self.notifier)
        self.client = TestClient(TestServer(self.app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.db.conn.close()

    async def call(self, method: str, path: str, uid: int | None = None, body=None, headers=None, data=None):
        h = dict(headers or {})
        if uid is not None:
            h["X-Init-Data"] = make_init(uid)
        kw = {"json": body} if body is not None else {"data": data} if data is not None else {}
        resp = await self.client.request(method, path, headers=h, **kw)
        try:
            payload = await resp.json()
        except Exception:  # noqa: BLE001
            payload = None
        await api.drain(self.app)
        self.last = resp
        return resp.status, payload

    async def create(self, uid: int, **spec) -> dict:
        status, data = await self.call("POST", "/api/challenges", uid, spec)
        self.assertEqual(status, 200, data)
        return data["challenge"]

    def shift_clock(self, days: int):
        base = datetime.now(timezone.utc)
        self.store.clock = lambda: base + timedelta(days=days)


class InitDataTests(ApiTestCase):
    async def test_health_without_auth(self):
        status, data = await self.call("GET", "/api/health")
        self.assertEqual((status, data), (200, {"ok": True}))

    async def test_valid_init_data_creates_user(self):
        status, data = await self.call("GET", "/api/challenges", 2)
        self.assertEqual((status, data), (200, {"challenges": []}))
        row = self.db.conn.execute("SELECT name, username, first_seen, last_seen FROM users WHERE id = 2").fetchone()
        self.assertEqual((row["name"], row["username"]), ("Ваня", "u2"))
        self.assertTrue(row["first_seen"] and row["last_seen"])
        # Повторный вход обновляет имя, а не создаёт дубль
        h = {"X-Init-Data": make_init(2, name="Иван")}
        status, _ = await self.call("GET", "/api/challenges", headers=h)
        self.assertEqual(status, 200)
        self.assertEqual(self.db.get(2).name, "Иван")
        self.assertEqual(self.db.scalar("SELECT COUNT(*) FROM users"), 1)

    async def test_tampered_init_data(self):
        good = make_init(2)
        forged = good.replace("%22id%22%3A2", "%22id%22%3A1")  # подменили id на админа
        self.assertNotEqual(good, forged)
        status, data = await self.call("GET", "/api/admin/stats", headers={"X-Init-Data": forged})
        self.assertEqual(status, 401)
        self.assertIn("error", data)
        for bad_header in ("", "hash=abc", make_init(2, token="654321:other-bot"), good + "&hash=0", "garbage"):
            status, _ = await self.call("GET", "/api/challenges", headers={"X-Init-Data": bad_header} if bad_header else {})
            self.assertEqual(status, 401, bad_header)

    async def test_expired_and_future_init_data(self):
        old = make_init(2, auth_date=int(time.time()) - 8 * 24 * 3600)
        status, data = await self.call("GET", "/api/challenges", headers={"X-Init-Data": old})
        self.assertEqual(status, 401)
        self.assertIn("устарела", data["error"])
        future = make_init(2, auth_date=int(time.time()) + 3600)
        status, _ = await self.call("GET", "/api/challenges", headers={"X-Init-Data": future})
        self.assertEqual(status, 401)
        almost = make_init(2, auth_date=int(time.time()) - 6 * 24 * 3600)
        status, _ = await self.call("GET", "/api/challenges", headers={"X-Init-Data": almost})
        self.assertEqual(status, 200)

    def test_check_init_data_unit(self):
        now = 1_760_000_000
        user = api.check_init_data(make_init(5, auth_date=now, name="<b>Ann</b>", signature="abc"), TOKEN, now=now)
        self.assertEqual(user, {"id": 5, "name": "<b>Ann</b>", "username": "u5"})
        # Пустые значения тоже участвуют в подписи (keep_blank_values)
        self.assertEqual(api.check_init_data(make_init(5, auth_date=now, start_param=""), TOKEN, now=now)["id"], 5)
        with self.assertRaises(api.ApiError):
            api.check_init_data(make_init(5, auth_date=now + 301), TOKEN, now=now)
        api.check_init_data(make_init(5, auth_date=now + 299), TOKEN, now=now)  # +5 минут допустимо


class CorsTests(ApiTestCase):
    async def test_preflight_allowed(self):
        status, _ = await self.call("OPTIONS", "/api/sync", headers={
            "Origin": ORIGIN, "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,x-init-data"})
        h = self.last.headers
        self.assertEqual(status, 204)
        self.assertEqual(h["Access-Control-Allow-Origin"], ORIGIN)
        self.assertIn("X-Init-Data", h["Access-Control-Allow-Headers"])
        self.assertIn("POST", h["Access-Control-Allow-Methods"])
        self.assertIn("Origin", h["Vary"])

    async def test_preflight_and_request_from_other_origin(self):
        status, _ = await self.call("OPTIONS", "/api/sync", headers={"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", self.last.headers)
        status, _ = await self.call("GET", "/api/challenges", 2, headers={"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        status, _ = await self.call("GET", "/api/challenges", 2, headers={"Origin": "http://127.0.0.1:8080"})
        self.assertEqual(status, 403)  # локальный адрес — только при DEV=1

    async def test_cors_headers_on_success_and_errors(self):
        status, _ = await self.call("GET", "/api/challenges", 2, headers={"Origin": ORIGIN})
        self.assertEqual(status, 200)
        self.assertEqual(self.last.headers["Access-Control-Allow-Origin"], ORIGIN)
        status, data = await self.call("GET", "/api/challenges", headers={"Origin": ORIGIN})
        self.assertEqual(status, 401)
        self.assertEqual(self.last.headers["Access-Control-Allow-Origin"], ORIGIN)  # мини-апп прочитает текст ошибки
        self.assertIn("error", data)

    def test_parse_origins(self):
        self.assertEqual(api.parse_origins(None), {ORIGIN})
        self.assertEqual(api.parse_origins(" https://a.example/ , https://b.example "), {"https://a.example", "https://b.example"})
        dev = api.parse_origins("", dev=True)
        self.assertTrue({ORIGIN, "http://127.0.0.1:8080", "http://localhost:8080"} <= dev)


class SyncTests(ApiTestCase):
    async def test_sync_saves_summary(self):
        today = datetime.now(timezone.utc).date().isoformat()
        body = sync_body(lifts={"bb_bench": 80, "leg_press": 160.5}, hist=[[today, 5400.5]])
        body["stats"]["unknown"] = "x"
        status, data = await self.call("POST", "/api/sync", 2, body)
        self.assertEqual((status, data), (200, {"ok": True}))
        row = self.db.conn.execute("SELECT * FROM app_stats WHERE user_id = 2").fetchone()
        self.assertEqual(json.loads(row["lifts"]), {"bb_bench": 80, "leg_press": 160.5})
        self.assertEqual(json.loads(row["hist"]), [[today, 5400.5]])
        self.assertEqual(json.loads(row["profile"])["goal"], "gain")
        self.assertNotIn("unknown", json.loads(row["stats"]))
        self.assertTrue(row["updated_at"].endswith("Z"))

    async def test_sync_soft_profile_fields(self):
        status, _ = await self.call("POST", "/api/sync", 2, sync_body(age="abc", weight=0, goal="fly", days=[1, 9]))
        self.assertEqual(status, 200)
        p = json.loads(self.db.conn.execute("SELECT profile FROM app_stats WHERE user_id = 2").fetchone()[0])
        self.assertEqual((p["age"], p["weight"], p["goal"], p["days"]), (None, None, None, None))

    async def test_sync_validation(self):
        today = datetime.now(timezone.utc).date().isoformat()
        cases = [
            [1, 2, 3],
            {"profile": "x"},
            {"lifts": [80]},
            {"lifts": {f"ex{i}": 10 for i in range(api.MAX_LIFTS + 1)}},
            {"hist": [[today, 10]] * (api.MAX_HIST + 1)},
            {"hist": "nope"},
        ]
        for body in cases:
            status, data = await self.call("POST", "/api/sync", 2, body)
            self.assertEqual(status, 400, body)
            self.assertIsInstance(data["error"], str)
        h = {"X-Init-Data": make_init(2), "Content-Type": "application/json"}
        for raw in (b"{bad json", b'{"lifts": {"bb_bench": NaN}}', b"", b"[" * 5000):
            status, _ = await self.call("POST", "/api/sync", headers=h, data=raw)
            self.assertEqual(status, 400, raw[:20])

    async def test_bad_entries_are_skipped_not_fatal(self):
        """Опечатка в весе (best в мини-аппе не уменьшается) или дата со сбитых часов не должны
        навсегда ломать синхронизацию: такие записи пропускаются, остальное сохраняется."""
        today = datetime.now(timezone.utc).date()
        d = lambda n: (today + timedelta(days=n)).isoformat()  # noqa: E731
        ch = await self.create(2, type="workouts", target=5, days=7)
        await self.call("POST", f"/api/challenges/{ch['code']}/join", 3)
        body = sync_body(
            lifts={"bb_bench": 80, "leg_press": 1200, "bb_squat": "100", "Bad Id!": 10, "deadlift": -5},
            hist=[[d(0), 5000], [d(0), 4000], [d(0), 3000], [d(3), 100], ["2026-13-45", 1], [d(0), -5],
                  [d(0), "x"], "junk", [], [d(-1), None]])
        status, data = await self.call("POST", "/api/sync", 3, body)
        self.assertEqual((status, data), (200, {"ok": True}))
        row = self.db.conn.execute("SELECT lifts, hist FROM app_stats WHERE user_id = 3").fetchone()
        self.assertEqual(json.loads(row["lifts"]), {"bb_bench": 80})
        self.assertEqual(json.loads(row["hist"]), [[d(-1), 0], [d(0), 5000], [d(0), 4000], [d(0), 3000]])
        _, data = await self.call("GET", f"/api/challenges/{ch['code']}", 3)
        self.assertEqual(data["challenge"]["my_progress"], 3)  # прогресс не замер

    async def test_stats_limits(self):
        body = sync_body()
        body["stats"] = {"workouts": 1e12, "volume": 2e9, "prs": 50, "streak": 1e12, "bestStreak": 30, "weekStreak": -1}
        status, _ = await self.call("POST", "/api/sync", 2, body)
        self.assertEqual(status, 200)
        st = json.loads(self.db.conn.execute("SELECT stats FROM app_stats WHERE user_id = 2").fetchone()[0])
        self.assertEqual(st, {"prs": 50, "bestStreak": 30})
        # Старые записи (до ограничений) не раздувают статистику админа
        self.db.conn.execute("UPDATE app_stats SET stats = ? WHERE user_id = 2", (json.dumps({"workouts": 1e12}),))
        _, s = await self.call("GET", "/api/admin/stats", ADMIN)
        self.assertEqual(s["workouts_total"], api.STAT_LIMITS["workouts"])

    async def test_workouts_per_day_cap(self):
        today = datetime.now(timezone.utc).date().isoformat()
        ch = await self.create(2, type="workouts", target=100, days=30)
        await self.call("POST", f"/api/challenges/{ch['code']}/join", 6)
        status, _ = await self.call("POST", "/api/sync", 6, sync_body(hist=[[today, 0]] * api.MAX_HIST))
        self.assertEqual(status, 200)
        _, data = await self.call("GET", f"/api/challenges/{ch['code']}", 6)
        self.assertEqual((data["challenge"]["my_progress"], data["challenge"]["status"]), (api.MAX_PER_DAY, "active"))
        # И для записей, сохранённых до ограничения
        self.db.conn.execute("UPDATE app_stats SET hist = ? WHERE user_id = 6", (json.dumps([[today, 0]] * 50),))
        self.assertEqual(self.store._progress_of(6, "workouts", "", today, None, datetime.now(timezone.utc).date()), 3)

    async def test_hist_beyond_60_is_kept(self):
        """Мини-апп присылает 60 последних тренировок: более старые сервер берёт из своей копии,
        поэтому цель 70 тренировок достижима. Меньше 60 — у клиента вся история, заменяем."""
        today = datetime.now(timezone.utc).date()
        ch = await self.create(2, type="workouts", target=70, days=60)
        full = []
        for day in range(40):
            self.shift_clock(day)
            dd = (today + timedelta(days=day)).isoformat()
            full += [[dd, 1000], [dd, 1000]]
            if day % 3 == 0 or day >= 33:
                status, _ = await self.call("POST", "/api/sync", 2, sync_body(hist=full[-api.HIST_CLIENT_CAP:]))
                self.assertEqual(status, 200)
            if day == 30:
                _, data = await self.call("GET", f"/api/challenges/{ch['code']}", 2)
                self.assertEqual(data["challenge"]["my_progress"], 62)
        _, data = await self.call("GET", f"/api/challenges/{ch['code']}", 2)
        c = data["challenge"]
        self.assertEqual((c["status"], c["winner"]["id"], c["my_progress"]), ("finished", 2, 70))
        stored = json.loads(self.db.conn.execute("SELECT hist FROM app_stats WHERE user_id = 2").fetchone()[0])
        self.assertEqual(len(stored), len(full))
        # Сброс данных в мини-аппе: пришло меньше 60 — старая история не воскресает
        await self.call("POST", "/api/sync", 2, sync_body(hist=[[full[-1][0], 500]]))
        hist = json.loads(self.db.conn.execute("SELECT hist FROM app_stats WHERE user_id = 2").fetchone()[0])
        self.assertEqual(hist, [[full[-1][0], 500]])

    def test_merge_hist_unit(self):
        today = datetime(2026, 10, 13).date()
        d = lambda n: (today - timedelta(days=n)).isoformat()  # noqa: E731
        prev = [[d(300), 1], [d(70), 2], [d(61), 3], [d(60), 4], [d(60), 5]]
        new = [[d(60), 5]] + [[d(i), 9] for i in range(58, -1, -1)]
        merged = api.merge_hist(prev, new, today)
        # 300 дней назад — старше HIST_KEEP_DAYS; d(60) — одна из двух добрана из сохранённой копии
        self.assertEqual(merged[:4], [[d(70), 2], [d(61), 3], [d(60), 4], [d(60), 5]])
        self.assertEqual(len(merged), 63)
        self.assertEqual(api.merge_hist(prev, [[d(0), 1]], today), [[d(0), 1]])
        # Клиент прислал 60, одна запись не прошла проверку — история всё равно считается обрезанной
        raw = new[:-1] + [["2999-01-01", 1]]
        data = api.validate_sync({"hist": raw}, today)
        self.assertEqual((len(data["hist"]), data["hist_truncated"]), (59, True))
        self.assertEqual(api.merge_hist(prev, data["hist"], today, data["hist_truncated"])[:3], merged[:3])

    async def test_body_limit(self):
        big = {"hist": [], "pad": "x" * (70 * 1024)}
        status, data = await self.call("POST", "/api/sync", 2, big)
        self.assertEqual(status, 413)
        self.assertIn("error", data)


class ChallengeTests(ApiTestCase):
    async def test_create_get_join_leave(self):
        ch = await self.create(2, type="lift", exercise="bb_bench", target=100)
        self.assertRegex(ch["code"], r"^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$")
        self.assertEqual((ch["type"], ch["exercise"], ch["exercise_name"]), ("lift", "bb_bench", "Жим штанги лёжа"))
        self.assertEqual((ch["target"], ch["days"], ch["ends_on"], ch["status"], ch["winner"]), (100, 0, None, "active", None))
        self.assertEqual(ch["title"], "Жим штанги лёжа — 100 кг")
        self.assertEqual(ch["invite_link"], f"https://t.me/testbot?start=ch_{ch['code']}")
        self.assertEqual([(p["id"], p["is_me"]) for p in ch["participants"]], [(2, True)])
        self.assertEqual(ch["my_progress"], 0)
        self.assertEqual(ch["created_by"], 2)

        # Чужой видит челлендж, но не участвует; код без учёта регистра
        status, data = await self.call("GET", f"/api/challenges/{ch['code'].lower()}", 3)
        self.assertEqual(status, 200)
        self.assertIsNone(data["challenge"]["my_progress"])
        self.assertFalse(any(p["is_me"] for p in data["challenge"]["participants"]))
        status, _ = await self.call("GET", "/api/challenges/ZZZZZ1", 3)
        self.assertEqual(status, 404)  # 1 нет в алфавите кодов
        status, _ = await self.call("GET", "/api/challenges/ABCDEF", 3)
        self.assertEqual(status, 404)

        status, data = await self.call("POST", f"/api/challenges/{ch['code']}/join", 3)
        self.assertEqual(status, 200)
        self.assertEqual(len(data["challenge"]["participants"]), 2)
        self.assertEqual(data["challenge"]["my_progress"], 0)
        self.assertEqual(len(self.tg.to(2)), 1)  # создателю: «Маша приняла/принял вызов»
        self.assertIn("Маша", self.tg.to(2)[0])
        self.assertIn("принял", self.tg.to(2)[0])
        self.assertEqual(self.tg.to(3), [])  # самому вступившему — нет
        markup = self.tg.sent[0][2]
        url = markup.inline_keyboard[0][0].web_app.url
        q = parse_qs(urlsplit(url).query)
        self.assertEqual((q["ch"], q["api"]), ([ch["code"]], ["https://1-2-3-4.sslip.io"]))
        self.assertEqual(markup.inline_keyboard[0][0].icon_custom_emoji_id, botmod.E["apps"])

        status, _ = await self.call("POST", f"/api/challenges/{ch['code']}/join", 3)  # повторно — без дублей
        self.assertEqual(status, 200)
        self.assertEqual(len(self.tg.to(2)), 1)

        status, data = await self.call("GET", "/api/challenges", 3)
        self.assertEqual([c["code"] for c in data["challenges"]], [ch["code"]])
        status, data = await self.call("POST", f"/api/challenges/{ch['code']}/leave", 3)
        self.assertEqual((status, data), (200, {"ok": True}))
        status, _ = await self.call("POST", f"/api/challenges/{ch['code']}/leave", 3)
        self.assertEqual(status, 400)
        status, data = await self.call("GET", "/api/challenges", 3)
        self.assertEqual(data["challenges"], [])

    async def test_create_validation(self):
        bad_specs = [
            {}, {"type": "run"}, {"type": "lift", "exercise": "curl", "target": 50},
            {"type": "lift", "exercise": "bb_bench", "target": 5},
            {"type": "lift", "exercise": "bb_bench", "target": 600},
            {"type": "lift", "exercise": "bb_bench", "target": 100, "days": 181},
            {"type": "lift", "exercise": "bb_bench", "target": "100"},
            {"type": "lift", "exercise": "bb_bench", "target": True},
            {"type": "workouts", "target": 10}, {"type": "workouts", "target": 10, "days": 0},
            {"type": "workouts", "target": 2.5, "days": 7}, {"type": "workouts", "target": 101, "days": 7},
            {"type": "workouts", "target": 10, "days": 91}, {"type": "workouts", "target": 10, "days": 7.5},
            {"type": "volume", "target": 999, "days": 7}, {"type": "volume", "target": 2_000_000, "days": 7},
        ]
        for spec in bad_specs:
            status, data = await self.call("POST", "/api/challenges", 2, spec)
            self.assertEqual(status, 400, spec)
            self.assertTrue(data["error"])
        ok = await self.create(2, type="lift", exercise="deadlift", target=142.5, days=30)
        self.assertEqual(ok["target"], 142.5)
        self.assertEqual(ok["title"], "Становая тяга — 142,5 кг")
        self.assertIsNotNone(ok["ends_on"])
        w = await self.create(2, type="workouts", target=12, days=30)
        self.assertEqual(w["title"], "12 тренировок за 30 дней")
        v = await self.create(2, type="volume", target=50000, days=14)
        self.assertEqual(v["title"], "50 000 кг объёма за 14 дней")

    async def test_create_rejected_if_goal_already_reached(self):
        await self.call("POST", "/api/sync", 2, sync_body(lifts={"bb_bench": 100}))
        status, data = await self.call("POST", "/api/challenges", 2, {"type": "lift", "exercise": "bb_bench", "target": 100})
        self.assertEqual(status, 400)
        self.assertIn("100 кг", data["error"])
        await self.create(2, type="lift", exercise="bb_bench", target=102.5)


class ProgressTests(ApiTestCase):
    async def test_lift_progress_and_single_winner(self):
        ch = await self.create(2, type="lift", exercise="bb_bench", target=100)
        code = ch["code"]
        await self.call("POST", f"/api/challenges/{code}/join", 3)
        await self.call("POST", "/api/sync", 3, sync_body(lifts={"bb_bench": 90}, sex="f"))
        _, data = await self.call("GET", f"/api/challenges/{code}", 2)
        c = data["challenge"]
        self.assertEqual([(p["id"], p["progress"]) for p in c["participants"]], [(3, 90), (2, 0)])
        self.assertEqual(c["status"], "active")

        self.tg.sent.clear()
        await self.call("POST", "/api/sync", 2, sync_body(lifts={"bb_bench": 100}))
        _, data = await self.call("GET", f"/api/challenges/{code}", 3)
        c = data["challenge"]
        self.assertEqual(c["status"], "finished")
        self.assertEqual(c["winner"], {"id": 2, "name": "Ваня"})
        self.assertEqual(c["participants"][0]["id"], 2)
        self.assertIsNotNone(c["participants"][0]["reached_at"])
        self.assertIsNotNone(c["finished_at"])
        self.assertEqual(len(self.tg.to(3)), 1)
        self.assertIn("Ваня</b> первым пожал 100 кг в жиме лёжа!", self.tg.to(3)[0])
        self.assertIn("Победа!", self.tg.to(2)[0])

        # Победитель фиксируется один раз: рекорд другого после финиша ничего не меняет
        await self.call("POST", "/api/sync", 3, sync_body(lifts={"bb_bench": 120}))
        _, data = await self.call("GET", f"/api/challenges/{code}", 3)
        self.assertEqual(data["challenge"]["winner"]["id"], 2)
        self.assertEqual(len(self.tg.sent), 2)
        status, _ = await self.call("POST", f"/api/challenges/{code}/join", 4)
        self.assertEqual(status, 400)  # в завершённый не вступить
        status, _ = await self.call("POST", f"/api/challenges/{code}/leave", 3)
        self.assertEqual(status, 400)

    async def test_lift_winner_is_joiner_who_already_lifts_more(self):
        await self.call("POST", "/api/sync", 3, sync_body(lifts={"bb_squat": 150}, sex="f"))
        ch = await self.create(2, type="lift", exercise="bb_squat", target=140)
        status, data = await self.call("POST", f"/api/challenges/{ch['code']}/join", 3)
        self.assertEqual(status, 200)
        self.assertEqual(data["challenge"]["winner"]["id"], 3)
        self.assertEqual(data["challenge"]["status"], "finished")
        texts = self.tg.to(2)
        self.assertTrue(any("Маша</b> приняла вызов" in t for t in texts), texts)
        self.assertTrue(any("Маша</b> первой присела со штангой 140 кг" in t for t in texts), texts)

    async def test_workouts_progress_window(self):
        today = datetime.now(timezone.utc).date()
        d = lambda n: (today + timedelta(days=n)).isoformat()  # noqa: E731
        ch = await self.create(2, type="workouts", target=3, days=7)
        self.assertEqual(ch["starts_on"], today.isoformat())
        self.assertEqual(ch["ends_on"], d(6))
        await self.call("POST", f"/api/challenges/{ch['code']}/join", 3)
        await self.call("POST", "/api/sync", 3, sync_body(hist=[[d(-3), 1000], [d(-1), 1000], [d(0), 2000], [d(0), 500]]))
        _, data = await self.call("GET", f"/api/challenges/{ch['code']}", 3)
        self.assertEqual(data["challenge"]["my_progress"], 2)  # до старта не считаются
        self.assertEqual(data["challenge"]["status"], "active")
        await self.call("POST", "/api/sync", 3, sync_body(hist=[[d(-1), 1000], [d(0), 2000], [d(0), 500], [d(1), 800]]))
        _, data = await self.call("GET", f"/api/challenges/{ch['code']}", 3)
        c = data["challenge"]
        self.assertEqual((c["my_progress"], c["status"], c["winner"]["id"]), (3, "finished", 3))
        self.assertTrue(any("первым достиг цели «3 тренировки за 7 дней»" in t for t in self.tg.to(2)))

    async def test_volume_progress(self):
        today = datetime.now(timezone.utc).date().isoformat()
        ch = await self.create(2, type="volume", target=10000, days=7)
        await self.call("POST", "/api/sync", 2, sync_body(hist=[[today, 4000.5], [today, 3000]]))
        _, data = await self.call("GET", f"/api/challenges/{ch['code']}", 2)
        self.assertEqual(data["challenge"]["my_progress"], 7000.5)
        self.assertEqual(data["challenge"]["status"], "active")
        await self.call("POST", "/api/sync", 2, sync_body(hist=[[today, 4000.5], [today, 3000], [today, 3000]]))
        _, data = await self.call("GET", "/api/challenges", 2)
        c = data["challenges"][0]
        self.assertEqual((c["status"], c["winner"]["id"], c["my_progress"]), ("finished", 2, 10000.5))

    async def test_deadline_leader_wins_with_places(self):
        today = datetime.now(timezone.utc).date().isoformat()
        ch = await self.create(2, type="workouts", target=10, days=3)
        for uid in (3, 4):
            await self.call("POST", f"/api/challenges/{ch['code']}/join", uid)
        await self.call("POST", "/api/sync", 3, sync_body(hist=[[today, 100], [today, 100]]))
        await self.call("POST", "/api/sync", 4, sync_body(hist=[[today, 100]]))
        self.tg.sent.clear()
        self.shift_clock(2)  # последний день — ещё идёт
        await botmod.challenges_tick(self.notifier)
        self.assertEqual(self.tg.sent, [])
        self.shift_clock(3)  # срок вышел
        await botmod.challenges_tick(self.notifier)
        row = self.store.challenge(ch["code"])
        self.assertEqual((row["status"], row["winner_id"]), ("finished", 3))
        self.assertEqual(len(self.tg.sent), 3)
        self.assertIn("Ты победил", self.tg.to(3)[0])
        self.assertIn("Твоё место: <b>3</b> из 3", self.tg.to(2)[0])
        self.assertIn("1. Маша — 2 тренировки", self.tg.to(2)[0])
        await botmod.challenges_tick(self.notifier)
        self.assertEqual(len(self.tg.sent), 3)  # итоги — один раз

    async def test_deadline_without_progress_has_no_winner(self):
        ch = await self.create(2, type="lift", exercise="bb_ohp", target=60, days=1)
        self.shift_clock(1)
        _, data = await self.call("GET", f"/api/challenges/{ch['code']}", 2)
        self.assertEqual((data["challenge"]["status"], data["challenge"]["winner"]), ("finished", None))
        self.assertIn("без победителя", self.tg.to(2)[0])


class LeaveRejoinTests(ApiTestCase):
    async def test_rejoin_does_not_notify_again(self):
        """Цикл «вышел — вступил» больше не канал спама: «принял вызов» — только при первом вступлении."""
        ch = await self.create(2, type="workouts", target=20, days=30)
        code = ch["code"]
        for uid in range(3, 6):
            await self.call("POST", f"/api/challenges/{code}/join", uid)
        self.tg.sent.clear()
        for _ in range(29):  # 58 запросов — в пределах лимита 60 в минуту
            s1, _ = await self.call("POST", f"/api/challenges/{code}/join", 99)
            s2, _ = await self.call("POST", f"/api/challenges/{code}/leave", 99)
            self.assertEqual((s1, s2), (200, 200))
        self.assertEqual(len(self.tg.to(2)), 1)  # только первое вступление
        self.assertEqual(len(self.tg.sent), 4)  # 2, 3, 4, 5 — по одному
        # Вышедший не виден ни в челлендже, ни в своём списке; вернулся — снова участник
        _, data = await self.call("GET", f"/api/challenges/{code}", 2)
        self.assertNotIn(99, [p["id"] for p in data["challenge"]["participants"]])
        _, data = await self.call("GET", "/api/challenges", 3)
        self.assertEqual(len(data["challenges"]), 1)
        status, data = await self.call("POST", f"/api/challenges/{code}/join", 99)
        self.assertEqual(status, 200)
        self.assertIn(99, [p["id"] for p in data["challenge"]["participants"]])
        self.assertEqual(len(self.tg.sent), 4)

    async def test_left_member_cannot_win_and_is_not_counted(self):
        ch = await self.create(2, type="lift", exercise="bb_bench", target=100)
        code = ch["code"]
        await self.call("POST", f"/api/challenges/{code}/join", 3)
        await self.call("POST", f"/api/challenges/{code}/leave", 3)
        await self.call("POST", "/api/sync", 3, sync_body(lifts={"bb_bench": 110}))
        _, data = await self.call("GET", f"/api/challenges/{code}", 2)
        self.assertEqual((data["challenge"]["status"], len(data["challenge"]["participants"])), ("active", 1))
        _, s = await self.call("GET", "/api/admin/stats", ADMIN)
        self.assertEqual(s["challenge_participants"], 1)
        # Вернулся с рекордом — победа засчитывается с момента возвращения
        status, data = await self.call("POST", f"/api/challenges/{code}/join", 3)
        self.assertEqual((status, data["challenge"]["status"], data["challenge"]["winner"]["id"]), (200, "finished", 3))

    async def test_creator_leaving(self):
        # Вышел из своего челленджа, где никого больше не было, — челлендж удаляется
        ch = await self.create(2, type="workouts", target=20, days=30)
        status, _ = await self.call("POST", f"/api/challenges/{ch['code']}/leave", 2)
        self.assertEqual(status, 200)
        status, _ = await self.call("GET", f"/api/challenges/{ch['code']}", 2)
        self.assertEqual(status, 404)
        self.assertEqual(self.store._count("SELECT COUNT(*) FROM challenges"), 0)
        self.assertEqual(self.store._count("SELECT COUNT(*) FROM participants"), 0)
        # Вышел из 10 своих, где остались друзья: лимит его больше не держит
        for _ in range(api.MAX_ACTIVE):
            c = await self.create(2, type="lift", exercise="bb_bench", target=100)
            await self.call("POST", f"/api/challenges/{c['code']}/join", 3 if _ < 5 else 4)
            await self.call("POST", f"/api/challenges/{c['code']}/leave", 2)
        _, data = await self.call("GET", "/api/challenges", 2)
        self.assertEqual(data["challenges"], [])
        await self.create(2, type="workouts", target=3, days=7)
        # Ушли все (создатель — раньше) — челлендж закрыт без победителя, строки остаются
        _, data = await self.call("GET", "/api/challenges", 3)
        code = data["challenges"][0]["code"]
        await self.call("POST", f"/api/challenges/{code}/leave", 3)
        row = self.store.challenge(code)
        self.assertEqual((row["status"], row["winner_id"]), ("finished", None))

    async def test_daily_create_limit(self):
        friends = iter(range(200, 300))
        for i in range(api.MAX_CREATED_PER_DAY):
            c = await self.create(5, type="workouts", target=50, days=30)
            await self.call("POST", f"/api/challenges/{c['code']}/join", next(friends))
            await self.call("POST", f"/api/challenges/{c['code']}/leave", 5)
        status, data = await self.call("POST", "/api/challenges", 5, {"type": "workouts", "target": 50, "days": 30})
        self.assertEqual(status, 400)
        self.assertIn("За сутки", data["error"])
        self.shift_clock(1)
        await self.create(5, type="workouts", target=50, days=30)

    async def test_late_join_after_deadline(self):
        """Срок вышел, планировщик ещё не прошёл: новичок не становится победителем, итоги рассылаются."""
        ch = await self.create(2, type="lift", exercise="bb_bench", target=120, days=7)
        code = ch["code"]
        await self.call("POST", f"/api/challenges/{code}/join", 3)
        await self.call("POST", "/api/sync", 2, sync_body(lifts={"bb_bench": 100}))
        await self.call("POST", "/api/sync", 3, sync_body(lifts={"bb_bench": 90}))
        await self.call("POST", "/api/sync", 4, sync_body(lifts={"bb_bench": 110}))
        self.tg.sent.clear()
        base = datetime.now(timezone.utc)
        self.store.clock = lambda: base + timedelta(days=7, seconds=30)
        status, data = await self.call("POST", f"/api/challenges/{code}/join", 4)
        self.assertEqual(status, 400)
        self.assertIn("завершён", data["error"])
        row = self.store.challenge(code)
        self.assertEqual((row["status"], row["winner_id"]), ("finished", 2))
        self.assertEqual(sorted(c for c, _, _ in self.tg.sent), [2, 3])  # итоги — участникам
        self.assertEqual(self.tg.to(4), [])
        # И напрямую через Store (без пересчёта в обработчике)
        c2 = await self.create(2, type="workouts", target=5, days=1)
        self.store.clock = lambda: base + timedelta(days=30)
        with self.assertRaises(api.ApiError):
            self.store.join(self.store.challenge(c2["code"]), {"id": 4, "name": "Петя", "username": "u4"})


class LimitTests(ApiTestCase):
    async def test_active_challenges_limit(self):
        for _ in range(api.MAX_ACTIVE):
            await self.create(2, type="workouts", target=5, days=7)
        status, data = await self.call("POST", "/api/challenges", 2, {"type": "workouts", "target": 5, "days": 7})
        self.assertEqual(status, 400)
        self.assertIn("10 активных", data["error"])
        other = await self.create(3, type="workouts", target=5, days=7)
        status, _ = await self.call("POST", f"/api/challenges/{other['code']}/join", 2)
        self.assertEqual(status, 400)  # и вступить больше нельзя

    async def test_participants_limit(self):
        ch = await self.create(2, type="workouts", target=5, days=7)
        for uid in range(100, 100 + api.MAX_PARTICIPANTS - 1):
            status, _ = await self.call("POST", f"/api/challenges/{ch['code']}/join", uid)
            self.assertEqual(status, 200)
        status, data = await self.call("POST", f"/api/challenges/{ch['code']}/join", 999)
        self.assertEqual(status, 400)
        self.assertIn("50", data["error"])

    async def test_rate_limit(self):
        for _ in range(api.RATE_LIMIT):
            status, _ = await self.call("GET", "/api/challenges", 2)
            self.assertEqual(status, 200)
        status, data = await self.call("GET", "/api/challenges", 2)
        self.assertEqual(status, 429)
        self.assertTrue(int(self.last.headers["Retry-After"]) >= 1)
        status, _ = await self.call("GET", "/api/challenges", 3)
        self.assertEqual(status, 200)  # лимит — на пользователя

    def test_rate_limiter_window(self):
        now = [0.0]
        rl = api.RateLimiter(limit=2, window=60, clock=lambda: now[0])
        self.assertEqual((rl.hit(1), rl.hit(1)), (0, 0))
        self.assertGreater(rl.hit(1), 0)
        now[0] = 61
        self.assertEqual(rl.hit(1), 0)


class AdminTests(ApiTestCase):
    async def test_admin_stats_access(self):
        status, data = await self.call("GET", "/api/admin/stats", 2)
        self.assertEqual((status, data), (403, {"error": "Нет доступа"}))
        today = datetime.now(timezone.utc).date().isoformat()
        await self.call("POST", "/api/sync", 2, sync_body(hist=[[today, 100]] * 3, goal="lose", level="advanced"))
        await self.call("POST", "/api/sync", 3, sync_body(sex="f"))
        await self.create(3, type="workouts", target=5, days=7)
        status, s = await self.call("GET", "/api/admin/stats", ADMIN)
        self.assertEqual(status, 200)
        self.assertEqual(s["users_total"], 3)
        self.assertEqual((s["users_new_7d"], s["active_7d"], s["synced_users"]), (3, 3, 2))
        self.assertEqual(s["workouts_total"], 3)
        self.assertEqual(s["challenges_active"], 1)
        self.assertEqual(s["goals"], {"lose": 1, "maintain": 0, "gain": 1})
        self.assertEqual(s["levels"], {"beginner": 1, "intermediate": 0, "advanced": 1})
        self.assertEqual(s["sexes"], {"m": 1, "f": 1})
        self.assertEqual(len(s["new_by_day"]), 30)
        self.assertEqual(s["new_by_day"][-1], [today, 3])

    async def test_bot_stats_text(self):
        await self.call("POST", "/api/sync", 2, sync_body(hist=[["2026-01-05", 100]]))
        text = botmod.stats_text()
        self.assertIn("Синхронизировались: <b>1 (100%)</b>", text)
        self.assertIn("Всего тренировок: <b>1</b>", text)
        self.assertIn("Набрать 100%", text)


class BotTests(ApiTestCase):
    def test_webapp_url(self):
        self.assertEqual(botmod.webapp_url(), "https://zed0306.github.io/gymapp/?api=https%3A%2F%2F1-2-3-4.sslip.io")
        self.assertEqual(botmod.webapp_url(ch="K7M2QX"),
                         "https://zed0306.github.io/gymapp/?ch=K7M2QX&api=https%3A%2F%2F1-2-3-4.sslip.io")
        old = botmod.WEBAPP_URL
        try:
            botmod.WEBAPP_URL = "https://example.com/app/?v=2&api=old#top"
            self.assertEqual(botmod.webapp_url(ch="K7M2QX"),
                             "https://example.com/app/?v=2&ch=K7M2QX&api=https%3A%2F%2F1-2-3-4.sslip.io#top")
        finally:
            botmod.WEBAPP_URL = old

    async def test_start_card(self):
        ch = await self.create(2, type="lift", exercise="bb_bench", target=100)
        msg = FakeMessage(3)
        self.db.touch(msg.from_user)
        await botmod.show_challenge_card(msg, self.tg, ch["code"])
        text, markup = msg.answers[0]
        self.assertIn("Тебя вызывают на челлендж", text)
        self.assertIn("Жим штанги лёжа — 100 кг", text)
        self.assertIn("Вызов бросил: <b>Ваня</b>", text)
        accept = markup.inline_keyboard[0][0]
        self.assertEqual(accept.text, "Принять вызов")
        self.assertIn(f"ch={ch['code']}", accept.web_app.url)
        self.assertIn("api=https%3A%2F%2F1-2-3-4.sslip.io", accept.web_app.url)
        self.assertEqual(accept.icon_custom_emoji_id, botmod.E["check"])

        msg = FakeMessage(3)
        await botmod.show_challenge_card(msg, self.tg, "QQQQQQ")
        self.assertIn("не найден", msg.answers[0][0])

    async def test_names_are_escaped(self):
        h = {"X-Init-Data": make_init(3, name="<script>&")}
        ch = await self.create(2, type="workouts", target=5, days=7)
        await self.call("POST", f"/api/challenges/{ch['code']}/join", headers=h)
        self.assertIn("&lt;script&gt;&amp;", self.tg.to(2)[0])
        self.assertNotIn("<script>", self.tg.to(2)[0])

    async def test_blocked_user_is_marked_and_skipped(self):
        ch = await self.create(2, type="workouts", target=5, days=7)
        await self.call("POST", f"/api/challenges/{ch['code']}/join", 3)
        self.assertEqual(len(self.tg.to(2)), 1)
        self.tg.blocked.add(2)
        await self.call("POST", f"/api/challenges/{ch['code']}/join", 4)  # уведомление 2 (ошибка) и 3
        self.assertEqual(self.db.get(2).blocked, 1)
        self.assertEqual(len(self.tg.to(3)), 1)
        self.tg.blocked.clear()
        attempts = []
        orig = self.tg.send_message

        async def spy(chat_id, *a, **kw):
            attempts.append(chat_id)
            return await orig(chat_id, *a, **kw)

        self.tg.send_message = spy
        await self.call("POST", f"/api/challenges/{ch['code']}/join", 5)
        self.assertNotIn(2, attempts)  # заблокировавшему больше не пишем (даже не пытаемся)
        self.assertEqual(len(self.tg.to(3)), 2)

    async def test_start_text_escapes_name(self):
        class State:
            async def clear(self):
                pass

        from aiogram.filters import CommandObject

        msg = FakeMessage(3)
        msg.from_user.first_name = "<3 Маша & <a href='x'>"
        await botmod.cmd_start(msg, CommandObject(prefix="/", command="start"), State(), self.tg)
        text = msg.answers[0][0]
        self.assertIn("Привет, &lt;3 Маша &amp; &lt;a href='x'&gt;!", text)
        self.assertNotIn("<a href", text)
        self.db.update(3, username="x<y>")
        users = botmod.users_text()
        self.assertIn("&lt;3 Маша &amp; &lt;a href='x'&gt; @x&lt;y&gt;", users)

    async def test_throttle_limits_rate_across_tasks(self):
        """Уведомления по разным событиям идут параллельно, но общий темп — не выше заданного."""
        stamps = []
        orig = self.tg.send_message

        async def timed(chat_id, *a, **kw):
            stamps.append(time.monotonic())
            return await orig(chat_id, *a, **kw)

        self.tg.send_message = timed
        botmod.THROTTLE = botmod.Throttle(100)
        ch = await self.create(2, type="workouts", target=20, days=30)
        for uid in range(10, 22):  # без drain между вступлениями — как на сервере
            r = await self.client.post(f"/api/challenges/{ch['code']}/join", headers={"X-Init-Data": make_init(uid)})
            self.assertEqual(r.status, 200)
        await api.drain(self.app, timeout=30)
        self.assertEqual(len(stamps), sum(range(1, 13)))  # 1 + 2 + … + 12 сообщений
        stamps.sort()
        peak = max(sum(1 for t in stamps if s <= t < s + 0.5) for s in stamps)
        self.assertLessEqual(peak, 51)  # 100 в секунду → не больше ~50 за полсекунды
        # RetryAfter от Telegram притормаживает всех
        botmod.THROTTLE.pause(0.2)
        t0 = time.monotonic()
        await botmod.THROTTLE.wait()
        self.assertGreaterEqual(time.monotonic() - t0, 0.15)

    async def test_notifier_errors_do_not_break_api(self):
        async def broken(ch, user):
            raise RuntimeError("telegram is down")

        self.notifier.joined = broken
        ch = await self.create(2, type="workouts", target=5, days=7)
        with self.assertLogs("gymapp.api", level="ERROR"):
            status, _ = await self.call("POST", f"/api/challenges/{ch['code']}/join", 3)
        self.assertEqual(status, 200)


class MigrationTests(unittest.TestCase):
    def test_idempotent_and_any_order(self):
        path = os.path.join(TMP, "order.db")
        import sqlite3

        conn = sqlite3.connect(path)
        api.Store(conn)  # API создал users первым — бот должен добрать свои колонки
        api.Store(conn)
        conn.close()
        d = botmod.DB(path)
        api.Store(d.conn)
        user = d.touch(FakeUser(7))
        self.assertEqual((user.id, user.tz, user.water_on), (7, 180, 1))
        tables = {r[0] for r in d.conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        self.assertTrue({"users", "app_stats", "challenges", "participants"} <= tables)
        d.conn.close()

    def test_helpers(self):
        self.assertEqual(api.fmt_num(50000), "50 000")
        self.assertEqual(api.fmt_num(102.5), "102,5")
        self.assertEqual(api.fmt_num(100.0), "100")
        self.assertEqual([api.plural(n, "день", "дня", "дней") for n in (1, 2, 5, 11, 21, 104)],
                         ["день", "дня", "дней", "дней", "день", "дня"])
        import sqlite3

        conn = sqlite3.connect(":memory:")
        self.addCleanup(conn.close)
        store = api.Store(conn)
        codes = {store._new_code() for _ in range(300)}
        self.assertEqual(len(codes), 300)
        self.assertTrue(all(api.CODE_RE.match(c) and not set(c) & set("01ILO") for c in codes))


if __name__ == "__main__":
    unittest.main()
