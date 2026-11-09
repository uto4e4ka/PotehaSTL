"""PotehaSTL token bot + API.

One process, Python standard library only:
  * Telegram bot (long polling): balance, personal API key, buying tokens for Telegram Stars.
  * HTTP API for the Chrome extension: check balance, spend tokens per export, refund failed exports.

Environment:
  BOT_TOKEN      Telegram bot token from @BotFather (required for the bot part)
  PORT           HTTP port (Railway sets it), default 8080
  DB_PATH        SQLite file, default ./potehastl.db (on Railway point it at a volume, e.g. /data/potehastl.db)
  FREE_TOKENS    tokens a new user gets, default 5
  COST_GLB       tokens per GLB export, default 1
  COST_STL       tokens per STL export, default 1
  PACKS          "tokens:stars,..." default "50:25,200:90,1000:400"
  ADMIN_IDS      comma-separated Telegram user ids allowed to use /give and /refund
"""

import html
import json
import logging
import os
import secrets
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

log = logging.getLogger("potehastl")

BOT_TOKEN = os.environ.get("BOT_TOKEN", "").strip()
PORT = int(os.environ.get("PORT", "8080"))
DB_PATH = os.environ.get("DB_PATH", "potehastl.db")
FREE_TOKENS = int(os.environ.get("FREE_TOKENS", "5"))
COSTS = {"glb": int(os.environ.get("COST_GLB", "1")), "stl": int(os.environ.get("COST_STL", "1"))}
ADMIN_IDS = {int(x) for x in os.environ.get("ADMIN_IDS", "").replace(" ", "").split(",") if x}
REFUND_WINDOW = 15 * 60  # a pending export older than this can no longer be refunded


def parse_packs(raw):
    packs = {}
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        tokens, stars = part.split(":")
        packs[int(tokens)] = int(stars)
    return dict(sorted(packs.items()))


PACKS = parse_packs(os.environ.get("PACKS", "50:25,200:90,1000:400"))
BOT_USERNAME = os.environ.get("BOT_USERNAME", "")  # filled from getMe at startup


def new_key():
    return "pst_" + secrets.token_urlsafe(24)


# ---------------------------------------------------------------- database

class DB:
    def __init__(self, path):
        d = os.path.dirname(path)
        if d:
            os.makedirs(d, exist_ok=True)
        self.conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.RLock()  # one shared connection, serialize all access
        with self.lock:
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    tg_id      INTEGER PRIMARY KEY,
                    username   TEXT,
                    api_key    TEXT UNIQUE NOT NULL,
                    balance    INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS spends (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    tg_id      INTEGER NOT NULL,
                    format     TEXT NOT NULL,
                    cost       INTEGER NOT NULL,
                    host       TEXT,
                    status     TEXT NOT NULL,   -- pending | done | refunded
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS payments (
                    charge_id  TEXT PRIMARY KEY,
                    tg_id      INTEGER NOT NULL,
                    stars      INTEGER NOT NULL,
                    tokens     INTEGER NOT NULL,
                    refunded   INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS spends_user ON spends(tg_id, id);
                """
            )

    def _one(self, sql, args=()):
        with self.lock:
            return self.conn.execute(sql, args).fetchone()

    def ensure_user(self, tg_id, username):
        with self.lock:
            row = self._one("SELECT * FROM users WHERE tg_id=?", (tg_id,))
            if row:
                if username and row["username"] != username:
                    self.conn.execute("UPDATE users SET username=? WHERE tg_id=?", (username, tg_id))
                return dict(row), False
            key = new_key()
            self.conn.execute(
                "INSERT INTO users(tg_id, username, api_key, balance, created_at) VALUES (?,?,?,?,?)",
                (tg_id, username, key, FREE_TOKENS, int(time.time())),
            )
            return dict(self._one("SELECT * FROM users WHERE tg_id=?", (tg_id,))), True

    def user(self, tg_id):
        row = self._one("SELECT * FROM users WHERE tg_id=?", (tg_id,))
        return dict(row) if row else None

    def by_key(self, key):
        if not key:
            return None
        row = self._one("SELECT * FROM users WHERE api_key=?", (key,))
        return dict(row) if row else None

    def rotate_key(self, tg_id):
        key = new_key()
        with self.lock:
            self.conn.execute("UPDATE users SET api_key=? WHERE tg_id=?", (key, tg_id))
        return key

    def spend(self, key, fmt, host):
        """Atomically take tokens for one export. Returns (ok, info)."""
        cost = COSTS[fmt]
        with self.lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                u = self._one("SELECT tg_id, balance FROM users WHERE api_key=?", (key,))
                if not u:
                    self.conn.execute("ROLLBACK")
                    return False, {"error": "bad_key"}
                if u["balance"] < cost:
                    self.conn.execute("ROLLBACK")
                    return False, {"error": "no_tokens", "balance": u["balance"], "cost": cost}
                self.conn.execute("UPDATE users SET balance=balance-? WHERE tg_id=?", (cost, u["tg_id"]))
                cur = self.conn.execute(
                    "INSERT INTO spends(tg_id, format, cost, host, status, created_at) VALUES (?,?,?,?,?,?)",
                    (u["tg_id"], fmt, cost, (host or "")[:200], "pending", int(time.time())),
                )
                self.conn.execute("COMMIT")
                return True, {"spend_id": cur.lastrowid, "cost": cost, "balance": u["balance"] - cost}
            except Exception:
                self.conn.execute("ROLLBACK")
                raise

    def finish(self, key, spend_id, ok):
        """Mark an export done, or give the tokens back if it failed (only own, pending, recent ones)."""
        with self.lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                u = self._one("SELECT tg_id FROM users WHERE api_key=?", (key,))
                if not u:
                    self.conn.execute("ROLLBACK")
                    return False, {"error": "bad_key"}
                s = self._one(
                    "SELECT * FROM spends WHERE id=? AND tg_id=? AND status='pending'", (spend_id, u["tg_id"])
                )
                refunded = False
                if s:
                    if not ok and time.time() - s["created_at"] <= REFUND_WINDOW:
                        self.conn.execute("UPDATE spends SET status='refunded' WHERE id=?", (spend_id,))
                        self.conn.execute(
                            "UPDATE users SET balance=balance+? WHERE tg_id=?", (s["cost"], u["tg_id"])
                        )
                        refunded = True
                    else:
                        self.conn.execute("UPDATE spends SET status='done' WHERE id=?", (spend_id,))
                bal = self._one("SELECT balance FROM users WHERE tg_id=?", (u["tg_id"],))["balance"]
                self.conn.execute("COMMIT")
                return True, {"refunded": refunded, "balance": bal}
            except Exception:
                self.conn.execute("ROLLBACK")
                raise

    def credit_payment(self, charge_id, tg_id, stars, tokens):
        """Idempotent: the same Telegram charge is credited once."""
        with self.lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                if self._one("SELECT 1 FROM payments WHERE charge_id=?", (charge_id,)):
                    self.conn.execute("ROLLBACK")
                    return False
                self.conn.execute(
                    "INSERT INTO payments(charge_id, tg_id, stars, tokens, created_at) VALUES (?,?,?,?,?)",
                    (charge_id, tg_id, stars, tokens, int(time.time())),
                )
                self.conn.execute("UPDATE users SET balance=balance+? WHERE tg_id=?", (tokens, tg_id))
                self.conn.execute("COMMIT")
                return True
            except Exception:
                self.conn.execute("ROLLBACK")
                raise

    def payment(self, charge_id):
        row = self._one("SELECT * FROM payments WHERE charge_id=?", (charge_id,))
        return dict(row) if row else None

    def mark_refunded(self, charge_id):
        with self.lock:
            p = self._one("SELECT * FROM payments WHERE charge_id=? AND refunded=0", (charge_id,))
            if not p:
                return None
            self.conn.execute("UPDATE payments SET refunded=1 WHERE charge_id=?", (charge_id,))
            self.conn.execute(
                "UPDATE users SET balance=MAX(0, balance-?) WHERE tg_id=?", (p["tokens"], p["tg_id"])
            )
            return dict(p)

    def add_tokens(self, tg_id, n):
        with self.lock:
            cur = self.conn.execute("UPDATE users SET balance=MAX(0, balance+?) WHERE tg_id=?", (n, tg_id))
            return cur.rowcount > 0

    def history(self, tg_id, limit=10):
        with self.lock:
            rows = self.conn.execute(
                "SELECT format, cost, host, status, created_at FROM spends WHERE tg_id=? ORDER BY id DESC LIMIT ?",
                (tg_id, limit),
            ).fetchall()
        return [dict(r) for r in rows]


db = None  # set in main()


# ---------------------------------------------------------------- Telegram

def tg(method, **params):
    data = json.dumps(params).encode()
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{BOT_TOKEN}/{method}",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            res = json.loads(r.read())
    except urllib.error.HTTPError as e:
        res = json.loads(e.read() or b"{}")
    if not res.get("ok"):
        log.warning("telegram %s failed: %s", method, res.get("description"))
    return res.get("result")


def main_keyboard():
    return {
        "inline_keyboard": [
            [{"text": "💰 Баланс", "callback_data": "bal"}, {"text": "⭐ Купить токены", "callback_data": "buy"}],
            [{"text": "🔑 Мой ключ", "callback_data": "key"}, {"text": "🧾 История", "callback_data": "hist"}],
        ]
    }


def plural_tokens(n):
    n10, n100 = n % 10, n % 100
    if n10 == 1 and n100 != 11:
        return f"{n} токен"
    if 2 <= n10 <= 4 and not 12 <= n100 <= 14:
        return f"{n} токена"
    return f"{n} токенов"


def costs_line():
    return f"GLB: {plural_tokens(COSTS['glb'])}, STL: {plural_tokens(COSTS['stl'])} за экспорт"


def send(chat_id, text, keyboard=None):
    params = {"chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
    if keyboard:
        params["reply_markup"] = keyboard
    return tg("sendMessage", **params)


def text_balance(u):
    return f"💰 Баланс: <b>{plural_tokens(u['balance'])}</b>\n{costs_line()}"


def text_key(u):
    return (
        "🔑 Ваш ключ для расширения PotehaSTL:\n"
        f"<code>{html.escape(u['api_key'])}</code>\n\n"
        "Вставьте его в окно расширения (иконка PotehaSTL в Chrome). "
        "Никому не показывайте: по ключу списываются ваши токены. Если он утёк, используйте /newkey."
    )


def send_packs(chat_id):
    rows = [[{"text": f"{plural_tokens(t)} за {s} ⭐", "callback_data": f"pack:{t}"}] for t, s in PACKS.items()]
    send(chat_id, "Выберите пакет токенов. Оплата в Telegram Stars.", {"inline_keyboard": rows})


def send_invoice(chat_id, tokens):
    stars = PACKS[tokens]
    tg(
        "sendInvoice",
        chat_id=chat_id,
        title=f"PotehaSTL: {plural_tokens(tokens)}",
        description=f"{plural_tokens(tokens)} на экспорт моделей в GLB/STL. {costs_line()}.",
        payload=f"pack:{tokens}:{stars}",
        provider_token="",
        currency="XTR",
        prices=[{"label": plural_tokens(tokens), "amount": stars}],
    )


def handle_message(msg):
    chat_id = msg["chat"]["id"]
    frm = msg.get("from") or {}
    uid = frm.get("id")
    if not uid:
        return
    username = frm.get("username")

    pay = msg.get("successful_payment")
    if pay:
        try:
            _, tokens, stars = pay["invoice_payload"].split(":")
            tokens, stars = int(tokens), int(stars)
        except ValueError:
            log.error("bad payload %r", pay.get("invoice_payload"))
            return
        if pay.get("currency") != "XTR" or pay.get("total_amount") != stars:
            log.error("payment mismatch %r", pay)
            return
        db.ensure_user(uid, username)
        if db.credit_payment(pay["telegram_payment_charge_id"], uid, stars, tokens):
            u = db.user(uid)
            send(chat_id, f"✅ Оплата прошла, начислено {plural_tokens(tokens)}.\n\n{text_balance(u)}", main_keyboard())
        return

    text = (msg.get("text") or "").strip()
    if not text.startswith("/"):
        send(chat_id, "Команды: /balance, /buy, /key, /history, /help", main_keyboard())
        return
    cmd, *args = text.split()
    cmd = cmd.split("@")[0].lower()

    if cmd == "/start":
        u, created = db.ensure_user(uid, username)
        hello = (
            "👋 Это бот <b>PotehaSTL</b>: он ведёт баланс токенов для расширения, "
            "которое вытаскивает 3D-модели со страниц на three.js в GLB или STL.\n\n"
        )
        if created and FREE_TOKENS:
            hello += f"🎁 Для старта начислено {plural_tokens(FREE_TOKENS)}.\n\n"
        send(chat_id, hello + text_balance(u) + "\n\n" + text_key(u), main_keyboard())
    elif cmd in ("/balance", "/bal"):
        u, _ = db.ensure_user(uid, username)
        send(chat_id, text_balance(u), main_keyboard())
    elif cmd == "/key":
        u, _ = db.ensure_user(uid, username)
        send(chat_id, text_key(u))
    elif cmd == "/newkey":
        db.ensure_user(uid, username)
        db.rotate_key(uid)
        send(chat_id, "Старый ключ больше не работает.\n\n" + text_key(db.user(uid)))
    elif cmd == "/buy":
        db.ensure_user(uid, username)
        send_packs(chat_id)
    elif cmd == "/history":
        db.ensure_user(uid, username)
        send(chat_id, text_history(uid))
    elif cmd == "/help":
        send(
            chat_id,
            "/balance: баланс\n/buy: купить токены\n/key: ключ для расширения\n"
            "/newkey: выпустить новый ключ\n/history: последние экспорты\n/paysupport: вопросы по оплате\n\n"
            f"{costs_line()}. Если экспорт не удался, токены возвращаются автоматически.",
        )
    elif cmd == "/paysupport":
        send(
            chat_id,
            "По вопросам оплаты напишите сюда, что случилось, и укажите дату покупки. "
            "Если токены не начислились, их начислят вручную или вернут звёзды.",
        )
    elif cmd == "/give" and uid in ADMIN_IDS:
        try:
            target, n = int(args[0]), int(args[1])
        except (IndexError, ValueError):
            send(chat_id, "Формат: /give <tg_id> <токены>")
            return
        ok = db.add_tokens(target, n)
        send(chat_id, "Готово." if ok else "Пользователь не найден.")
    elif cmd == "/refund" and uid in ADMIN_IDS:
        if not args:
            send(chat_id, "Формат: /refund <telegram_payment_charge_id>")
            return
        p = db.payment(args[0])
        if not p or p["refunded"]:
            send(chat_id, "Платёж не найден или уже возвращён.")
            return
        if tg("refundStarPayment", user_id=p["tg_id"], telegram_payment_charge_id=args[0]):
            db.mark_refunded(args[0])
            send(chat_id, f"Возвращено {p['stars']} ⭐, списано {plural_tokens(p['tokens'])}.")
        else:
            send(chat_id, "Telegram не принял возврат, подробности в логах.")
    else:
        send(chat_id, "Не знаю такой команды. /help", main_keyboard())


def text_history(uid):
    rows = db.history(uid)
    if not rows:
        return "Экспортов пока не было."
    marks = {"done": "✅", "refunded": "↩️", "pending": "⏳"}
    lines = ["🧾 Последние экспорты:"]
    for r in rows:
        when = time.strftime("%d.%m %H:%M", time.gmtime(r["created_at"]))
        lines.append(
            f"{marks.get(r['status'], '•')} {when} UTC · {r['format'].upper()} · "
            f"-{r['cost']} · {html.escape(r['host'] or '?')}"
        )
    return "\n".join(lines)


def handle_callback(cq):
    uid = cq["from"]["id"]
    chat_id = cq["message"]["chat"]["id"] if cq.get("message") else uid
    data = cq.get("data") or ""
    tg("answerCallbackQuery", callback_query_id=cq["id"])
    u, _ = db.ensure_user(uid, cq["from"].get("username"))
    if data == "bal":
        send(chat_id, text_balance(u), main_keyboard())
    elif data == "key":
        send(chat_id, text_key(u))
    elif data == "hist":
        send(chat_id, text_history(uid))
    elif data == "buy":
        send_packs(chat_id)
    elif data.startswith("pack:"):
        try:
            tokens = int(data.split(":")[1])
        except ValueError:
            return
        if tokens in PACKS:
            send_invoice(chat_id, tokens)


def handle_pre_checkout(q):
    ok, err = True, None
    try:
        _, tokens, stars = q["invoice_payload"].split(":")
        tokens, stars = int(tokens), int(stars)
        if PACKS.get(tokens) != stars or q.get("total_amount") != stars or q.get("currency") != "XTR":
            ok, err = False, "Цена пакета изменилась, откройте /buy заново."
    except ValueError:
        ok, err = False, "Неизвестный пакет."
    params = {"pre_checkout_query_id": q["id"], "ok": ok}
    if err:
        params["error_message"] = err
    tg("answerPreCheckoutQuery", **params)


def handle_update(upd):
    try:
        if "message" in upd:
            handle_message(upd["message"])
        elif "callback_query" in upd:
            handle_callback(upd["callback_query"])
        elif "pre_checkout_query" in upd:
            handle_pre_checkout(upd["pre_checkout_query"])
    except Exception:
        log.exception("update failed: %r", upd)


def poll_forever():
    global BOT_USERNAME
    me = tg("getMe")
    if me:
        BOT_USERNAME = me.get("username", BOT_USERNAME)
        log.info("bot @%s started", BOT_USERNAME)
    tg(
        "setMyCommands",
        commands=[
            {"command": "balance", "description": "Баланс токенов"},
            {"command": "buy", "description": "Купить токены"},
            {"command": "key", "description": "Ключ для расширения"},
            {"command": "history", "description": "Последние экспорты"},
            {"command": "help", "description": "Помощь"},
        ],
    )
    offset = 0
    while True:
        try:
            updates = tg(
                "getUpdates",
                offset=offset,
                timeout=50,
                allowed_updates=["message", "callback_query", "pre_checkout_query"],
            )
        except Exception:
            log.exception("getUpdates failed")
            time.sleep(5)
            continue
        for upd in updates or []:
            offset = upd["update_id"] + 1
            handle_update(upd)
        if updates is None:
            time.sleep(3)


# ---------------------------------------------------------------- HTTP API

class Api(BaseHTTPRequestHandler):
    server_version = "PotehaSTL/1"

    def log_message(self, fmt, *args):
        log.info("%s %s", self.address_string(), fmt % args)

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _key(self):
        h = self.headers.get("Authorization", "")
        return h[7:].strip() if h.lower().startswith("bearer ") else ""

    def _json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 4096:
            return None
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return None

    def _extra(self):
        return {"bot_url": f"https://t.me/{BOT_USERNAME}" if BOT_USERNAME else None, "costs": COSTS}

    def do_OPTIONS(self):
        self._send(204, {})

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            return self._send(200, {"ok": True})
        if path == "/api/balance":
            u = db.by_key(self._key())
            if not u:
                return self._send(401, {"error": "bad_key", **self._extra()})
            return self._send(200, {"balance": u["balance"], **self._extra()})
        self._send(404, {"error": "not_found"})

    def do_POST(self):
        path = urlparse(self.path).path
        body = self._json()
        if body is None:
            return self._send(400, {"error": "bad_json"})
        key = self._key()
        if path == "/api/spend":
            fmt = str(body.get("format", "")).lower()
            if fmt not in COSTS:
                return self._send(400, {"error": "bad_format"})
            ok, info = db.spend(key, fmt, str(body.get("host", "")))
            if ok:
                return self._send(200, {**info, **self._extra()})
            code = 401 if info["error"] == "bad_key" else 402
            return self._send(code, {**info, **self._extra()})
        if path == "/api/finish":
            try:
                spend_id = int(body.get("spend_id"))
            except (TypeError, ValueError):
                return self._send(400, {"error": "bad_spend_id"})
            ok, info = db.finish(key, spend_id, bool(body.get("ok")))
            return self._send(200 if ok else 401, {**info, **self._extra()})
        self._send(404, {"error": "not_found"})


def main():
    global db
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    db = DB(DB_PATH)
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Api)
    log.info("API on :%d, db %s", PORT, DB_PATH)
    if BOT_TOKEN:
        threading.Thread(target=poll_forever, daemon=True).start()
    else:
        log.warning("BOT_TOKEN is not set: running the API only")
    srv.serve_forever()


if __name__ == "__main__":
    main()
