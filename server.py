"""Same-origin Ping Point booking service. Python 3.11+, no external dependencies."""
import argparse
import copy
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from http import cookies
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

import identity
import analytics
import payments
import access

ROOT = Path(__file__).resolve().parent
MOSCOW = timezone(timedelta(hours=3))
SETTINGS = dict(open=600, close=1230, border=780, priceAm=400, pricePm=500, racket=100,
                minLeadMin=60, cancelHours=3, holdMin=15, maxPlayers=4,
                rules=['Бронь минимум за 1 час до начала игры', 'Отмена не позднее чем за 3 часа — возврат 100%',
                       'Дети до 14 лет — только вместе со взрослым', 'Сменная или не скользящая обувь',
                       'Без еды и алкоголя, вода из кулера — можно'])
LABELS = dict(pending='Ожидает оплаты', paid='Оплачена', expired='Истекла', cancelled='Отменена',
              refunded='Возврат', refund_partial='Частичный возврат', noshow='Неявка',
              refund_pending='Возврат обрабатывается', payment_review='Оплата требует проверки')


class APIError(Exception):
    def __init__(self, code, message, status=400):
        self.code, self.message, self.status = code, message, status


def now_ms():
    return int(time.time() * 1000)


def uid(prefix):
    return prefix + '_' + secrets.token_urlsafe(18)


def checked_date(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise APIError('VALID', 'Выберите дату')
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise APIError('VALID', 'Выберите существующую дату') from None


def at_ms(ds, minute):
    day = checked_date(ds)
    return int((datetime(day.year, day.month, day.day, tzinfo=MOSCOW) + timedelta(minutes=minute)).timestamp() * 1000)


def integer(value, name, lower, upper, step=1):
    if isinstance(value, bool):
        raise APIError('VALID', 'Проверьте поле: ' + name)
    try:
        number = float(value)
        if not number.is_integer() or not lower <= number <= upper or number % step:
            raise ValueError()
        return int(number)
    except (TypeError, ValueError, OverflowError):
        raise APIError('VALID', 'Проверьте поле: ' + name) from None


def hhmm(minute):
    return f'{minute // 60:02d}:{minute % 60:02d}'


def occupied(db, ds, exclude=None):
    intervals = [(b['start'], b['start'] + b['dur'], 'busy') for b in db['bookings']
                 if b['date'] == ds and b['id'] != exclude and b['status'] in {'pending', 'paid', 'noshow'}]
    intervals += [(b['start'], b['end'], 'blocked') for b in db['blocks'] if b['date'] == ds]
    return intervals


def check_range(db, ds, start, dur, exclude=None, ignore_lead=False):
    checked_date(ds)
    s = db['settings']
    start = integer(start, 'начало', s['open'], s['close'], 30)
    dur = integer(dur, 'длительность', 60, 240, 30)
    if start + dur > s['close']:
        raise APIError('VALID', 'Игра должна закончиться до закрытия комнаты')
    if not ignore_lead and at_ms(ds, start) - now_ms() < s['minLeadMin'] * 60000:
        raise APIError('LEAD', 'Бронь — не позднее чем за час до начала')
    if any(start < end and start + dur > begin for begin, end, _ in occupied(db, ds, exclude)):
        raise APIError('BUSY', 'Это время уже занято — выберите другое', 409)
    return start, dur


def find_promo(db, code):
    if not code:
        return None
    code = str(code).strip().upper()
    promo = next((p for p in db['promos'] if p['code'] == code and p['active']), None)
    if not promo or (promo['limit'] and promo['used'] >= promo['limit']):
        raise APIError('PROMO', 'Промокод недоступен')
    return promo


def quote(db, start, dur, rackets=0, code=None, promo_terms=None):
    s = db['settings']
    start = integer(start, 'начало', s['open'], s['close'] - 60, 30)
    dur = integer(dur, 'длительность', 60, 240, 30)
    rackets = integer(rackets or 0, 'ракетки', 0, s['maxPlayers'])
    if start + dur > s['close']:
        raise APIError('VALID', 'Игра должна закончиться до закрытия комнаты')
    rent = sum((s['priceAm'] if minute < s['border'] else s['pricePm']) / 2 for minute in range(start, start + dur, 30))
    extra = rackets * s['racket'] * dur / 60
    subtotal = rent + extra
    promo = promo_terms if promo_terms is not None else find_promo(db, code)
    discount = (int(subtotal * promo['value'] / 100 + 0.5) if promo['type'] == 'pct' else min(subtotal, promo['value'])) if promo else 0
    return dict(rent=rent, rackets=extra, subtotal=subtotal, discount=discount, total=subtotal - discount)


def manual_quote(db, body):
    """Admin-only input uses the same validated pricing for preview and creation."""
    players = integer(body.get('players', 2), 'игроки', 1, db['settings']['maxPlayers'])
    rackets = integer(body.get('rackets', 0), 'ракетки', 0, players)
    result = quote(db, body.get('start'), body.get('dur'), rackets, body.get('promo'))
    result['tariffTotal'] = result['total']
    if body.get('amount') is not None and body['amount'] != '':
        result['total'] = integer(body['amount'], 'сумма', 0, 9007199254740991)
    return result


def consume_promo(db, booking):
    """Called inside the same SQLite transaction that changes a booking to paid."""
    if booking.get('promo') and not booking.get('promoConsumed'):
        promo = find_promo(db, booking['promo'])
        promo['used'] += 1
        booking['promoConsumed'] = True


def granted_promo(db, booking):
    if not booking.get('promo'):
        return None
    if booking.get('promoTerms'):
        return booking['promoTerms']
    # Compatibility for pre-snapshot bookings: availability is irrelevant to an
    # already granted discount; use the saved definition even if now exhausted.
    promo = next((p for p in db['promos'] if p['code'] == booking['promo']), None)
    return {key: promo[key] for key in ['code', 'type', 'value']} if promo else dict(type='rub', value=booking['discount'])


def booking_view(db, booking):
    result = copy.deepcopy(booking)
    result.pop('owner', None)
    result.pop('accessToken', None)
    start = at_ms(booking['date'], booking['start'])
    left = start - now_ms()
    paid = booking['status'] == 'paid'
    result.update(startTs=start, endTs=start + booking['dur'] * 60000, isPast=start + booking['dur'] * 60000 < now_ms(),
                  statusLabel=LABELS.get(booking['status'], booking['status']),
                  cancelFree=paid and left >= db['settings']['cancelHours'] * 3600000,
                  cancelLate=paid and 0 < left < db['settings']['cancelHours'] * 3600000,
                  canCancel=booking['status'] == 'pending' or (paid and left > 0),
                  canReschedule=paid and not booking.get('rescheduled') and left >= db['settings']['cancelHours'] * 3600000,
                  refundAmount=booking.get('refundAmount'), payment=next((payments.Payments.public(p) for p in db['payments'] if p['id'] == booking.get('paymentId')), None),
                  timeLabel=hhmm(booking['start']) + '–' + hhmm(booking['start'] + booking['dur']),
                  dateLabel=checked_date(booking['date']).strftime('%d.%m.%Y'), phoneFmt='+' + booking['phone'])
    return result


def private_booking(db, ident, session):
    booking = next((b for b in db['bookings'] if b['id'] == ident), None)
    if not booking or (not owns_booking(booking, session) and not session['admin']):
        raise APIError('NOTFOUND', 'Бронь не найдена', 404)
    return booking


def owns_booking(booking, session):
    # A phone number is a login label, never proof of booking ownership.
    if booking.get('userId'):
        return booking['userId'] == session.get('userId')
    return booking.get('owner') == session['id']


def record(booking, status, by='client', note=''):
    booking['status'] = status
    booking['history'].append(dict(at=now_ms(), s=status, by=by, note=note))


def refund_amount(db, booking, amount):
    remaining = amount
    for payment in reversed(db['payments']):
        if payment['bookingId'] != booking['id'] or payment['status'] not in {'succeeded', 'partially_refunded'}:
            continue
        if payment.get('provider') == 'yookassa':
            raise APIError('SETTLEMENT_REQUIRED', 'Возврат ЮKassa требует подтверждения провайдера', 409)
        take = min(remaining, payment['amount'] - payment.get('refunded', 0))
        payment['refunded'] = payment.get('refunded', 0) + take
        payment['refundedAt'] = now_ms()
        payment['status'] = 'refunded' if payment['refunded'] == payment['amount'] else 'partially_refunded'
        remaining -= take
    return amount - remaining


class Store:
    def __init__(self, path):
        self.path = str(path)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as conn:
            conn.execute('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, data TEXT NOT NULL)')
            conn.execute('CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, csrf TEXT NOT NULL, admin INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL)')
            if 'user_id' not in {row[1] for row in conn.execute('PRAGMA table_info(sessions)')}:
                conn.execute('ALTER TABLE sessions ADD COLUMN user_id TEXT')
            initial = dict(settings=SETTINGS, bookings=[], payments=[], blocks=[], promos=[], seq=0, consents=[])
            conn.execute('INSERT OR IGNORE INTO state VALUES (1, ?)', (json.dumps(initial),))

    @contextmanager
    def connect(self):
        conn = sqlite3.connect(self.path, timeout=15)
        conn.execute('PRAGMA busy_timeout=15000')
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def transaction(self, action):
        with self.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            state = json.loads(conn.execute('SELECT data FROM state WHERE id=1').fetchone()[0])
            self.defaults(state)
            self.expire(state)
            result = action(state)
            conn.execute('UPDATE state SET data=? WHERE id=1', (json.dumps(state, ensure_ascii=False),))
            return result

    @staticmethod
    def defaults(state):
        for key in ['users', 'authChallenges', 'credentials', 'paymentOperations', 'accessGrants', 'accessEvents', 'refundOperations']:
            state.setdefault(key, [])

    @staticmethod
    def expire(state):
        for booking in state['bookings']:
            if booking['status'] == 'pending' and booking.get('expiresAt') and booking['expiresAt'] <= now_ms():
                booking['status'] = 'expired'
                booking['history'].append(dict(at=now_ms(), s='expired', by='server'))
                for payment in state['payments']:
                    if payment['bookingId'] == booking['id'] and payment['status'] == 'pending':
                        payment['status'] = 'canceled'


class Handler(SimpleHTTPRequestHandler):
    server_version = 'PingPoint/1'

    def log_message(self, fmt, *args):
        # Request paths can include identifiers or search terms; do not log PII or credentials.
        pass

    def reply(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if getattr(self, 'new_cookie', None):
            self.send_header('Set-Cookie', self.new_cookie)
        self.end_headers()
        self.wfile.write(body)

    def session(self):
        jar = cookies.SimpleCookie()
        try:
            jar.load(self.headers.get('Cookie', ''))
        except cookies.CookieError:
            pass
        raw = jar['pp_session'].value if 'pp_session' in jar else ''
        token = hashlib.sha256(raw.encode()).hexdigest() if raw else ''
        with self.server.store.connect() as conn:
            row = conn.execute('SELECT csrf, admin, user_id FROM sessions WHERE token=? AND expires>?', (token, now_ms())).fetchone()
            if not row:
                raw = secrets.token_urlsafe(32)
                token = hashlib.sha256(raw.encode()).hexdigest()
                csrf = secrets.token_urlsafe(24)
                conn.execute('INSERT INTO sessions (token,csrf,admin,expires) VALUES (?, ?, 0, ?)', (token, csrf, now_ms() + 180 * 86400000))
                self.set_session_cookie(raw)
                row = (csrf, 0, None)
        return dict(id=token, csrf=row[0], admin=bool(row[1]), userId=row[2])

    def set_session_cookie(self, raw):
        self.new_cookie = 'pp_session=' + raw + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=15552000' + ('; Secure' if self.server.secure_cookie else '')

    def rotate_session(self, session, user_id=None, admin=False, claim=False, verified=None, new_password_hash=None):
        raw, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(24)
        token = hashlib.sha256(raw.encode()).hexdigest()
        # Claims are scoped to the actual browser cookie. Never claim by phone.
        with self.server.store.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            if user_id:
                state = json.loads(conn.execute('SELECT data FROM state WHERE id=1').fetchone()[0])
                user = next((u for u in state.get('users', []) if u['id'] == user_id), None)
                source = conn.execute('SELECT token FROM sessions WHERE token=? AND expires>?', (session['id'], now_ms())).fetchone()
                if not user or not source or not verified or user.get('authRevision', 0) != verified.get('authRevision', 0) or user['passwordHash'] != verified['passwordHash']:
                    raise APIError('AUTH', 'Данные входа изменились. Войдите заново', 401)
                if new_password_hash is not None:
                    user['passwordHash'] = new_password_hash
                    user['authRevision'] = user.get('authRevision', 0) + 1
                    state['authChallenges'] = [c for c in state.get('authChallenges', []) if c.get('userId') != user_id]
                    conn.execute('DELETE FROM sessions WHERE user_id=?', (user_id,))
                else:
                    user['lastLoginAt'] = now_ms()
            if claim:
                for booking in state['bookings']:
                    if not booking.get('userId') and booking.get('owner') == session['id']:
                        booking['userId'] = user_id
            if user_id:
                conn.execute('UPDATE state SET data=? WHERE id=1', (json.dumps(state, ensure_ascii=False),))
            conn.execute('DELETE FROM sessions WHERE token=?', (session['id'],))
            conn.execute('INSERT INTO sessions(token,csrf,admin,expires,user_id) VALUES (?,?,?,?,?)',
                         (token, csrf, int(admin), now_ms() + 180 * 86400000, user_id))
        session.update(id=token, csrf=csrf, admin=admin, userId=user_id)
        self.set_session_cookie(raw)
        return csrf

    def do_GET(self):
        if urlsplit(self.path).path.startswith('/api/'):
            self.api('GET')
            return
        path = unquote(urlsplit(self.path).path)
        if path == '/':
            self.send_response(302)
            self.send_header('Location', '/1-neon/index.html')
            self.end_headers()
            return
        if not self.public_static_file(path):
            self.reply(dict(error=dict(code='NOTFOUND', message='Файл не найден')), 404)
            return
        super().do_GET()

    def public_static_file(self, path):
        target = (ROOT / path.lstrip('/')).resolve()
        allowed = {'.html', '.css', '.js', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico', '.woff', '.woff2', '.ttf'}
        site_file = path.startswith('/1-neon/') and target.is_relative_to(ROOT / '1-neon') and target.suffix.lower() in allowed
        image_file = path.startswith('/img/') and target.is_relative_to(ROOT / 'img') and target.suffix.lower() in {'.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico'}
        return target.is_file() and (site_file or image_file)

    def do_HEAD(self):
        if not self.public_static_file(unquote(urlsplit(self.path).path)):
            self.send_error(404)
            return
        super().do_HEAD()

    def translate_path(self, path):
        return str((ROOT / unquote(urlsplit(path).path).lstrip('/')).resolve())

    def do_POST(self):
        self.api('POST')

    def api(self, method):
        try:
            self.new_cookie = None
            host = self.headers.get('Host', '')
            if host not in self.server.allowed_hosts:
                raise APIError('HOST', 'Недопустимый адрес сервера', 403)
            session = self.session()
            body = {}
            if method == 'POST':
                external = urlsplit(self.path).path in {'/api/yookassa/webhook', '/api/access/verify'}
                origin = self.headers.get('Origin')
                if not external and origin and origin not in {'http://' + host, 'https://' + host}:
                    raise APIError('CSRF', 'Обновите страницу', 403)
                if not external and not hmac.compare_digest(self.headers.get('X-PP-CSRF', ''), session['csrf']):
                    raise APIError('CSRF', 'Обновите страницу', 403)
                length = int(self.headers.get('Content-Length', 0))
                if length < 0 or length > 65536:
                    raise APIError('VALID', 'Слишком большой запрос', 413)
                body = json.loads(self.rfile.read(length) or b'{}')
                if not isinstance(body, dict):
                    raise APIError('VALID', 'Некорректный запрос')
            route = urlsplit(self.path)
            query = {key: values[0] for key, values in parse_qs(route.query).items()}
            result = self.dispatch(method, route.path, body, query, session)
            self.reply(result)
        except (APIError, identity.IdentityError, payments.PaymentError) as error:
            self.reply(dict(error=dict(code=error.code, message=error.message)), error.status)
        except (ValueError, KeyError, TypeError):
            self.reply(dict(error=dict(code='VALID', message='Некорректные данные запроса')), 400)
        except Exception:
            self.reply(dict(error=dict(code='SERVER', message='Не удалось выполнить запрос. Повторите позже.')), 500)

    def dispatch(self, method, path, body, query, session):
        if method == 'GET' and path == '/api/session':
            return self.server.store.transaction(lambda db: dict(settings=db['settings'], admin=session['admin'], csrf=session['csrf'],
                demoPayments=self.server.demo_payments, user=identity.profile(self.server.accounts.user(db, session)),
                capabilities=dict(accounts=True, passkeys=bool(self.server.accounts.origin),
                                  payments='demo' if self.server.demo_payments else self.server.payments.provider.readiness()['mode'],
                                  access=self.server.access.readiness()['mode'])))
        if path.startswith('/api/account/'):
            return self.account_route(method, path, body, session)
        if path == '/api/admin/login' and method == 'POST':
            self.server.accounts.limiter.check('admin-login', self.client_address[0], limit=20)
            login, password = str(body.get('login', '')), str(body.get('password', ''))
            if not self.server.admin_login or not self.server.admin_password or not hmac.compare_digest(login, self.server.admin_login) or not hmac.compare_digest(password, self.server.admin_password):
                raise APIError('AUTH', 'Неверный логин или пароль; доступ задаётся на сервере', 403)
            with self.server.store.connect() as conn:
                conn.execute('UPDATE sessions SET admin=1 WHERE token=?', (session['id'],))
            return True
        if path == '/api/admin/logout' and method == 'POST':
            with self.server.store.connect() as conn:
                conn.execute('UPDATE sessions SET admin=0 WHERE token=?', (session['id'],))
            return True
        if path.startswith('/api/admin/') and not session['admin']:
            raise APIError('AUTH', 'Войдите в админку сервера', 403)
        if path == '/api/yookassa/webhook' and method == 'POST':
            self.server.accounts.limiter.check('webhook', self.client_address[0], limit=300, seconds=60)
            return self.server.payments.webhook(body)
        if path in {'/api/access/verify', '/api/admin/access/simulate'} and method == 'POST':
            payload, door = body.get('payload'), body.get('doorId')
            simulation = path.endswith('/simulate')
            if not simulation and not self.server.access.authorized(self.headers.get('Authorization', ''), door):
                # No hostile QR content, bearer, or claimed door IDs are retained.
                self.server.store.transaction(lambda db: db['accessEvents'].append(dict(at=now_ms(),
                    doorId=self.server.access.door_id or 'unconfigured', result='deny', reason='unauthorized')))
                raise APIError('DEVICE_AUTH', 'Устройство не авторизовано', 403)
            if not isinstance(payload, str) or not 1 <= len(payload) <= 256 or not isinstance(door, str) or len(door) > 100:
                raise APIError('VALID', 'Некорректный запрос устройства')
            return self.server.store.transaction(lambda db: self.server.access.verify(db, payload, door, now_ms(), at_ms, simulation))
        match = re.fullmatch(r'/api/bookings/([^/]+)/access', path)
        if match and method == 'GET':
            return self.server.store.transaction(lambda db: self.server.access.view(db, private_booking(db, match[1], session), now_ms(), at_ms))
        match = re.fullmatch(r'/api/bookings/([^/]+)/payments', path)
        if match and method == 'POST' and not self.server.demo_payments:
            return self.server.payments.start(match[1], session)
        match = re.fullmatch(r'/api/payments/([^/]+)/refresh', path)
        if match and method == 'POST':
            return self.server.payments.refresh(match[1], session)
        match = re.fullmatch(r'/api/(admin/)?bookings/([^/]+)/(cancel|partial-refund|refund-fault)', path)
        if match and method == 'POST':
            if match[3] != 'cancel' and not session['admin']:
                raise APIError('AUTH', 'Операция доступна администратору', 403)
            # Authority is checked before provider I/O; transaction re-checks it too.
            real = self.server.store.transaction(lambda db: any(p['id'] == private_booking(db, match[2], session).get('paymentId')
                and p.get('provider') == 'yookassa' and p.get('paidAt') for p in db['payments']))
            if real:
                return self.server.payments.refund(match[2], session, match[3], body)
        return self.server.store.transaction(lambda db: self.operation(db, method, path, body, query, session))

    def account_route(self, method, path, body, session):
        accounts = self.server.accounts
        peer = self.client_address[0]
        if path == '/api/account/documents' and method == 'GET':
            return dict(list=identity.documents())
        if method == 'POST' and path in {'/api/account/register', '/api/account/login'}:
            user = accounts.register(body, peer) if path.endswith('/register') else accounts.login(body, peer)
            csrf = self.rotate_session(session, user['id'], claim=True, verified=user)
            return dict(user=identity.profile(user), csrf=csrf)
        if path == '/api/account/logout' and method == 'POST':
            return dict(user=None, csrf=self.rotate_session(session))
        if path == '/api/account/me' and method == 'GET':
            return self.server.store.transaction(lambda db: dict(user=identity.profile(accounts.user(db, session))))
        if path == '/api/account/profile' and method == 'POST':
            return self.server.store.transaction(lambda db: accounts.update(db, body, session))
        if path == '/api/account/password' and method == 'POST':
            accounts.limiter.check('password', peer, session.get('userId', ''), limit=10)
            user = self.server.store.transaction(lambda db: accounts.user(db, session, True))
            if not identity.password_matches(body.get('currentPassword'), user['passwordHash']):
                raise APIError('AUTH', 'Неверный текущий пароль', 401)
            hashed = identity.password_hash(body.get('newPassword'))
            return dict(ok=True, csrf=self.rotate_session(session, user['id'], verified=user, new_password_hash=hashed))
        match = re.fullmatch(r'/api/account/passkeys/(register|login)/(options|verify)', path)
        if match and method == 'POST':
            purpose, action = match.groups()
            accounts.limiter.check('passkey', peer, limit=40)
            if action == 'options':
                return self.server.store.transaction(lambda db: accounts.options(db, session, purpose, body.get('phone')))
            result = accounts.verify(body, session, purpose)
            if purpose == 'login':
                return dict(user=identity.profile(result), csrf=self.rotate_session(session, result['id'], claim=True, verified=result))
            return result
        if path == '/api/account/passkeys' and method == 'GET':
            def listing(db):
                user = accounts.user(db, session, True)
                return dict(list=[{k: c[k] for k in ['id', 'name', 'createdAt']} for c in db['credentials'] if c['userId'] == user['id']])
            return self.server.store.transaction(listing)
        if path == '/api/account/passkeys/delete' and method == 'POST':
            def remove(db):
                user = accounts.user(db, session, True)
                db['credentials'] = [c for c in db['credentials'] if not (c['userId'] == user['id'] and c['id'] == body.get('id'))]
                return dict(ok=True)
            return self.server.store.transaction(remove)
        raise APIError('NOTFOUND', 'Маршрут не найден', 404)

    def operation(self, db, method, path, body, query, session):
        if path == '/api/availability' and method == 'GET':
            ds = query.get('date')
            checked_date(ds)
            exclude = query.get('excludeId')
            if exclude:
                private_booking(db, exclude, session)
            occupied_slots = occupied(db, ds, exclude)
            s = db['settings']
            slots = []
            for minute in range(s['open'], s['close'], 30):
                state = next((status for start, end, status in occupied_slots if minute < end and minute + 30 > start), 'free')
                if at_ms(ds, minute) - now_ms() < s['minLeadMin'] * 60000:
                    state = 'past'
                slots.append(dict(start=minute, state=state, rate=s['priceAm'] if minute < s['border'] else s['pricePm']))
            return dict(date=ds, settings=s, slots=slots)
        if path == '/api/promos/apply' and method == 'POST':
            promo = find_promo(db, body.get('code'))
            if not promo:
                raise APIError('PROMO', 'Введите промокод')
            q = quote(db, body.get('start'), body.get('dur'), body.get('rackets', 0), promo['code'])
            return dict(code=promo['code'], type=promo['type'], value=promo['value'], discount=q['discount'], total=q['total'], note='Скидка по промокоду')
        if path == '/api/bookings' and method == 'POST':
            return self.create_booking(db, body, session)
        if path == '/api/bookings/mine' and method == 'GET':
            mine = [booking_view(db, b) for b in db['bookings'] if owns_booking(b, session) and b['status'] != 'expired']
            upcoming = [b for b in mine if b['endTs'] >= now_ms() and b['status'] in {'paid', 'pending'}]
            past = [b for b in mine if b not in upcoming]
            return dict(upcoming=sorted(upcoming, key=lambda b: b['startTs']), past=sorted(past, key=lambda b: -b['startTs']))
        match = re.fullmatch(r'/api/bookings/([^/]+)(?:/(payments|cancel|reschedule|reschedule-quote))?', path)
        if match:
            booking = private_booking(db, match[1], session)
            action = match[2]
            if method == 'GET' and not action:
                return booking_view(db, booking)
            if method == 'POST' and action == 'cancel':
                return self.cancel_booking(db, booking)
            if method == 'POST' and action == 'payments':
                self.require_demo()
                if booking['status'] != 'pending':
                    raise APIError('EXPIRED' if booking['status'] == 'expired' else 'STATE', 'Бронь не ожидает оплаты')
                for payment in db['payments']:
                    if payment['bookingId'] == booking['id'] and payment['status'] == 'pending':
                        payment['status'] = 'canceled'
                payment = self.payment(db, booking, body.get('method', 'card'), 'pending', booking['amount'])
                booking['paymentId'] = payment['id']
                return payment
            if method == 'POST' and action in {'reschedule', 'reschedule-quote'}:
                return self.reschedule(db, booking, body, action == 'reschedule-quote')
        match = re.fullmatch(r'/api/payments/([^/]+)/confirm', path)
        if match and method == 'POST':
            self.require_demo()
            payment = next((p for p in db['payments'] if p['id'] == match[1]), None)
            if not payment:
                raise APIError('NOTFOUND', 'Платёж не найден', 404)
            if payment.get('provider') == 'yookassa':
                raise APIError('PROVIDER_REQUIRED', 'Платёж подтверждается только через ЮKassa', 409)
            booking = private_booking(db, payment['bookingId'], session)
            if booking['status'] != 'pending' or payment['status'] != 'pending' or booking['paymentId'] != payment['id']:
                raise APIError('EXPIRED' if booking['status'] == 'expired' else 'STATE', 'Платёж уже завершён или время удержания вышло')
            if payment['method'] == 'card':
                card = re.sub(r'\D', '', str(body.get('card', '')))
                if card != '5555555555554444':
                    payment['status'] = 'failed'
                    return dict(ok=False, reason='Тестовая карта отклонена. Используйте 5555 5555 5555 4444.')
                payment['cardMask'] = '•• 4444'
            consume_promo(db, booking)
            payment.update(status='succeeded', paidAt=now_ms())
            booking.update(expiresAt=None, code=None, test=True)
            record(booking, 'paid', 'demo-payment', 'Тестовая оплата. Деньги не списаны. Код двери не выдаётся.')
            return dict(ok=True, booking=booking_view(db, booking))
        if path.startswith('/api/admin/'):
            return self.admin_operation(db, method, path, body, query, session)
        raise APIError('NOTFOUND', 'Маршрут не найден', 404)

    def require_demo(self):
        if not self.server.demo_payments:
            raise APIError('PAYMENT_DISABLED', 'Онлайн-оплата ещё не подключена. Бронь удерживается 15 минут; обратитесь к администратору.', 503)

    @staticmethod
    def payment(db, booking, method, status, amount):
        if method not in {'card', 'sbp', 'cash', 'terminal'}:
            raise APIError('VALID', 'Выберите способ оплаты')
        payment = dict(id=uid('pay'), bookingId=booking['id'], amount=amount, method=method, status=status,
                       createdAt=now_ms(), paidAt=now_ms() if status == 'succeeded' else None,
                       cardMask=None, refundedAt=None, test=True)
        db['payments'].append(payment)
        return payment

    def create_booking(self, db, body, session, manual=False):
        phone = re.sub(r'\D', '', str(body.get('phone', '')))
        if len(phone) == 11 and phone.startswith('8'):
            phone = '7' + phone[1:]
        if not re.fullmatch(r'7\d{10}', phone):
            raise APIError('PHONE', 'Проверьте номер телефона')
        name = str(body.get('name', '')).strip()
        if not 2 <= len(name) <= 60:
            raise APIError('NAME', 'Укажите имя (от 2 до 60 символов)')
        consents = body.get('consents', {})
        if not manual and (not isinstance(consents, dict) or not all(consents.get(key) is True for key in ['offer', 'policy', 'consent_pd'])):
            raise APIError('CONSENT', 'Подтвердите оферту, политику и согласие на обработку данных')
        start, dur = check_range(db, body.get('date'), body.get('start'), body.get('dur'), ignore_lead=manual)
        players = integer(body.get('players', 2), 'игроки', 1, db['settings']['maxPlayers'])
        rackets = integer(body.get('rackets', 0), 'ракетки', 0, players)
        q = manual_quote(db, body) if manual else quote(db, start, dur, rackets, body.get('promo'))
        if manual and 'expectedAmount' in body and integer(body['expectedAmount'], 'подтверждённая сумма', 0, 9007199254740991) != q['total']:
            raise APIError('QUOTE_CHANGED', 'Расчёт изменился. Проверьте новую сумму и повторите сохранение.', 409)
        note = body.get('note', '') if manual else ''
        if not isinstance(note, str):
            raise APIError('VALID', 'Проверьте поле: заметка')
        promo = find_promo(db, body.get('promo'))
        paid = manual and body.get('pay', 'unpaid') != 'unpaid'
        if paid:
            self.require_demo()
        db['seq'] += 1
        booking = dict(id=uid('bk'), number='PP-' + str(db['seq']), owner=session['id'], userId=session.get('userId') if not manual else None, name=name,
                       phone=phone, date=body['date'], start=start, dur=dur, players=players, rackets=rackets,
                       promo=promo['code'] if promo else None,
                       promoTerms={key: promo[key] for key in ['code', 'type', 'value']} if promo else None,
                       discount=q['discount'], amount=q['total'],
                       status='pending', code=None, createdAt=now_ms(), expiresAt=now_ms() + db['settings']['holdMin'] * 60000,
                       source='admin' if manual else 'site', paymentId=None, partnerResponseId=body.get('partnerResponseId'), history=[])
        if manual:
            booking['note'] = note[:200]
        record(booking, 'pending', 'admin' if manual else 'client', 'Время удерживается 15 минут')
        db['bookings'].append(booking)
        if not manual:
            # The server stores the exact accepted document revisions, never a client-provided hash.
            for doc, filename, version in [('offer', 'oferta.html', '2.0'), ('policy', 'politika.html', '1.0'), ('consent_pd', 'soglasie-pd.html', '1.0')]:
                digest = hashlib.sha256((ROOT / '1-neon' / 'docs' / filename).read_bytes()).hexdigest()
                db['consents'].append(dict(bookingId=booking['id'], docId=doc, docVersion=version, hash=digest, acceptedAt=now_ms()))
        if paid:
            consume_promo(db, booking)
            payment = self.payment(db, booking, body['pay'], 'succeeded', booking['amount'])
            booking.update(paymentId=payment['id'], expiresAt=None, test=True)
            record(booking, 'paid', 'admin', 'Тестовая отметка оплаты, без движения денег')
        return booking_view(db, booking)

    def cancel_booking(self, db, booking, admin=False, with_refund=True):
        if booking['status'] == 'pending' or (admin and not with_refund and booking['status'] == 'paid'):
            record(booking, 'cancelled', 'admin' if admin else 'client')
            for payment in db['payments']:
                if payment['bookingId'] == booking['id'] and payment['status'] == 'pending':
                    payment['status'] = 'canceled'
        elif booking['status'] == 'paid':
            left = at_ms(booking['date'], booking['start']) - now_ms()
            if left <= 0 and not admin:
                raise APIError('STARTED', 'Игра уже началась — отмена недоступна')
            if admin or left >= db['settings']['cancelHours'] * 3600000:
                booking['refundAmount'] = refund_amount(db, booking, booking['amount'])
                record(booking, 'refunded', 'admin' if admin else 'client', 'Тестовый возврат')
            else:
                booking['refundAmount'] = None
                record(booking, 'refund_partial', note='Сумму возврата рассчитает администратор')
        else:
            raise APIError('STATE', 'Эту бронь отменить нельзя')
        return booking_view(db, booking)

    def reschedule(self, db, booking, body, only_quote=False, admin=False):
        if not admin:
            if booking['status'] != 'paid' or booking.get('rescheduled'):
                raise APIError('STATE', 'Перенос доступен один раз для оплаченной брони')
            if at_ms(booking['date'], booking['start']) - now_ms() < db['settings']['cancelHours'] * 3600000:
                raise APIError('LATE', 'Перенос доступен не позднее чем за 3 часа')
        elif booking['status'] not in {'paid', 'pending'}:
            raise APIError('STATE', 'Перенести можно только активную бронь')
        ds = body.get('date', booking['date'])
        start, dur = check_range(db, ds, body.get('start', booking['start']), body.get('dur', booking['dur']), booking['id'], admin)
        q = quote(db, start, dur, booking['rackets'], promo_terms=granted_promo(db, booking))
        diff = q['total'] - booking['amount']
        real = any(p['id'] == booking.get('paymentId') and p.get('provider') == 'yookassa' for p in db['payments'])
        if real and diff:
            raise APIError('SETTLEMENT_REQUIRED', 'Изменение цены оплаченной брони требует отдельного расчёта с ЮKassa; автоматический перенос недоступен', 409)
        if only_quote:
            return dict(oldAmount=booking['amount'], newAmount=q['total'], diff=diff)
        if booking['status'] == 'paid' and diff:
            self.require_demo()
            if diff > 0:
                self.payment(db, booking, 'card', 'succeeded', diff)['kind'] = 'surcharge'
            else:
                refund_amount(db, booking, -diff)
        booking.update(date=ds, start=start, dur=dur, amount=q['total'], discount=q['discount'])
        if real:
            self.server.access.issue(db, booking, at_ms)
        if not admin:
            booking['rescheduled'] = True
        record(booking, booking['status'], 'admin' if admin else 'client', 'Перенос времени')
        view = booking_view(db, booking)
        return view if admin else dict(booking=view, diff=diff)

    def admin_operation(self, db, method, path, body, query, session):
        if path == '/api/admin/analytics' and method == 'GET':
            try:
                result = analytics.summarize(db, query)
                result['from'] = result.pop('from_')
                return result
            except analytics.AnalyticsError as error:
                raise APIError('VALID', str(error)) from None
        if path == '/api/admin/integrations' and method == 'GET':
            return dict(payments=self.server.payments.provider.readiness() if not self.server.demo_payments else
                dict(mode='demo', configured=False, missing=[], message='Локальная имитация: деньги не списываются; доступ не выдаётся'),
                access=self.server.access.readiness(),
                passkeys=dict(configured=bool(self.server.accounts.origin), origin=self.server.accounts.origin or None,
                    rpId=self.server.accounts.rp_id or None, message='Ключ устройства проверяет отпечаток, лицо или PIN; биометрия не передаётся сайту'))
        if path == '/api/admin/access-events' and method == 'GET':
            limit = integer(query.get('limit', 50), 'лимит', 1, 200)
            allowed = ['at', 'bookingId', 'doorId', 'result', 'reason']
            return dict(list=[{k: e[k] for k in allowed if k in e} for e in sorted(db['accessEvents'], key=lambda e: -e['at'])[:limit]], total=len(db['accessEvents']))
        if path == '/api/admin/users' and method == 'GET':
            page = integer(query.get('page', 1), 'страница', 1, 1000000)
            size = integer(query.get('pageSize', 30), 'размер страницы', 1, 100)
            text = str(query.get('q', '')).strip().casefold()[:100]
            users = [u for u in db['users'] if text in (u['name'] + ' ' + u['phone']).casefold()]
            users.sort(key=lambda u: (u['createdAt'], u['id']), reverse=True)
            def view(user):
                bookings = [b for b in db['bookings'] if b.get('userId') == user['id']]
                payments = [p for p in db['payments'] if p.get('paidAt') and not p.get('test', True) and
                            p.get('status') in {'succeeded', 'refunded', 'partially_refunded', 'requires_review'} and
                            p['bookingId'] in {b['id'] for b in bookings}]
                return dict(id=user['id'], name=user['name'], phone=user['phone'], phoneVerified=False,
                    createdAt=user['createdAt'], lastLoginAt=user.get('lastLoginAt'), bookingsCount=len(bookings),
                    paidCount=len(payments), totalPaid=sum(analytics.kopecks(p['amount']) for p in payments) / 100)
            return dict(list=[view(u) for u in users[(page-1)*size:page*size]], total=len(users), page=page, pageSize=size)
        user_match = re.fullmatch(r'/api/admin/users/([^/]+)', path)
        if user_match and method == 'GET':
            user = next((u for u in db['users'] if u['id'] == user_match[1]), None)
            if not user:
                raise APIError('NOTFOUND', 'Пользователь не найден', 404)
            return dict(user=identity.profile(user), bookings=[booking_view(db, b) for b in db['bookings'] if b.get('userId') == user['id']],
                        registrations=[c for c in db['consents'] if c.get('subjectId') == user['id']])
        if path == '/api/admin/auth' and method == 'GET':
            return True
        if path == '/api/admin/bookings/quote' and method == 'POST':
            check_range(db, body.get('date'), body.get('start'), body.get('dur'), ignore_lead=True)
            return manual_quote(db, body)
        if path == '/api/admin/bookings/create' and method == 'POST':
            return self.create_booking(db, body, session, True)
        if path == '/api/admin/bookings' and method == 'GET':
            bookings = db['bookings']
            for key in ['date', 'status']:
                if query.get(key):
                    bookings = [b for b in bookings if b[key] == query[key]]
            if query.get('from'):
                bookings = [b for b in bookings if b['date'] >= query['from']]
            if query.get('to'):
                bookings = [b for b in bookings if b['date'] <= query['to']]
            if query.get('q'):
                term = re.sub(r'[\s()+-]', '', query['q']).lower()
                bookings = [b for b in bookings if any(term in re.sub(r'[\s()+-]', '', str(b[key])).lower() for key in ['name', 'number', 'phone'])]
            return [booking_view(db, b) for b in sorted(bookings, key=lambda b: (b['date'], b['start']), reverse=query.get('asc') != 'true')]
        match = re.fullmatch(r'/api/admin/bookings/([^/]+)(?:/(cancel|move|noshow|partial-refund|refund-fault|manual-payment))?', path)
        if match:
            booking = private_booking(db, match[1], session)
            action = match[2]
            if method == 'GET' and not action:
                view = booking_view(db, booking)
                view['payments'] = [payments.Payments.public(p) for p in db['payments'] if p['bookingId'] == booking['id']]
                view['refunds'] = [{k: r[k] for k in ['id', 'paymentId', 'amount', 'status', 'createdAt', 'succeededAt', 'providerId'] if k in r}
                    for r in db['refundOperations'] if r['bookingId'] == booking['id']]
                return view
            if method == 'POST' and action == 'cancel':
                return self.cancel_booking(db, booking, True, body.get('withRefund', False) is True)
            if method == 'POST' and action == 'move':
                return self.reschedule(db, booking, body, admin=True)
            if method == 'POST' and action == 'manual-payment':
                self.require_demo()
                if booking['status'] != 'pending':
                    raise APIError('STATE', 'Бронь не ожидает оплаты')
                consume_promo(db, booking)
                payment = self.payment(db, booking, body.get('method'), 'succeeded', booking['amount'])
                booking.update(paymentId=payment['id'], expiresAt=None, test=True)
                record(booking, 'paid', 'admin', 'Тестовая отметка оплаты')
                return booking_view(db, booking)
            if method == 'POST' and action == 'noshow':
                if booking['status'] != 'paid' or at_ms(booking['date'], booking['start']) > now_ms():
                    raise APIError('STATE', 'Отметить неявку можно после начала оплаченной игры')
                record(booking, 'noshow', 'admin')
                self.server.access.revoke(db, booking['id'])
                return booking_view(db, booking)
            if method == 'POST' and action == 'partial-refund':
                if booking['status'] != 'refund_partial' or booking.get('refundAmount') is not None:
                    raise APIError('STATE', 'Бронь не ожидает расчёта возврата')
                amount = integer(body.get('amount'), 'возврат', 0, booking['amount'])
                booking['refundAmount'] = refund_amount(db, booking, amount)
                record(booking, 'refund_partial', 'admin', str(body.get('note', ''))[:200])
                return booking_view(db, booking)
            if method == 'POST' and action == 'refund-fault':
                if booking['status'] not in {'paid', 'noshow', 'refund_partial'}:
                    raise APIError('STATE', 'Возврат недоступен')
                refunded = booking.get('refundAmount') or 0
                booking['refundAmount'] = refunded + refund_amount(db, booking, booking['amount'] - refunded)
                record(booking, 'refunded', 'admin', str(body.get('note', ''))[:200])
                return booking_view(db, booking)
        if path == '/api/admin/blocks' and method == 'GET':
            return sorted(db['blocks'], key=lambda b: (b['date'], b['start']))
        if path == '/api/admin/blocks/create' and method == 'POST':
            ds = body.get('date')
            checked_date(ds)
            s = db['settings']
            start = integer(body.get('start'), 'начало блокировки', s['open'], s['close'] - 30, 30)
            end = integer(body.get('end'), 'конец блокировки', start + 30, s['close'], 30)
            block = dict(id=uid('blk'), date=ds, start=start, end=end, reason=str(body.get('reason') or 'Закрыто')[:80], createdAt=now_ms())
            clashes = [booking_view(db, b) for b in db['bookings'] if b['date'] == ds and b['status'] in {'pending', 'paid'} and start < b['start'] + b['dur'] and end > b['start']]
            db['blocks'].append(block)
            return dict(block=block, clashes=clashes)
        match = re.fullmatch(r'/api/admin/blocks/([^/]+)/delete', path)
        if match and method == 'POST':
            db['blocks'] = [b for b in db['blocks'] if b['id'] != match[1]]
            return True
        if path == '/api/admin/settings' and method == 'GET':
            return db['settings']
        if path == '/api/admin/settings' and method == 'POST':
            s = copy.deepcopy(db['settings'])
            limits = dict(open=(0, 1410, 30), close=(30, 1440, 30), border=(0, 1440, 30), priceAm=(2, 100000, 2), pricePm=(2, 100000, 2),
                          racket=(0, 10000, 2), minLeadMin=(0, 1440, 1), cancelHours=(0, 168, 1), holdMin=(1, 60, 1))
            for key, bounds in limits.items():
                if body.get(key) not in {None, ''}:
                    s[key] = integer(body[key], key, *bounds)
            if s['close'] - s['open'] < 120 or not s['open'] <= s['border'] <= s['close']:
                raise APIError('VALID', 'Проверьте часы работы и границу тарифа')
            if 'rules' in body:
                if not isinstance(body['rules'], list):
                    raise APIError('VALID', 'Проверьте правила')
                s['rules'] = [str(rule).strip()[:300] for rule in body['rules'][:12] if str(rule).strip()]
            db['settings'] = s
            return s
        if path == '/api/admin/promos' and method == 'GET':
            return db['promos']
        if path == '/api/admin/promos/save' and method == 'POST':
            code = str(body.get('code', '')).strip().upper()
            if not re.fullmatch(r'[A-ZА-Я0-9_-]{3,20}', code):
                raise APIError('VALID', 'Проверьте промокод')
            kind = body.get('type')
            if kind not in {'pct', 'rub'}:
                raise APIError('VALID', 'Проверьте тип скидки')
            value = integer(body.get('value'), 'скидка', 1, 90 if kind == 'pct' else 100000)
            existing = next((p for p in db['promos'] if p['code'] == code), None)
            if existing and body.get('isNew'):
                raise APIError('VALID', 'Такой промокод уже есть')
            if not existing:
                existing = dict(code=code, used=0, active=True)
                db['promos'].append(existing)
            existing.update(type=kind, value=value, limit=integer(body.get('limit', 0), 'лимит', 0, 1000000), note=str(body.get('note', ''))[:80])
            if 'active' in body:
                existing['active'] = body['active'] is True
            return existing
        if path == '/api/admin/promos/toggle' and method == 'POST':
            promo = next((p for p in db['promos'] if p['code'] == body.get('code')), None)
            if not promo:
                raise APIError('NOTFOUND', 'Промокод не найден', 404)
            promo['active'] = body.get('active') is True
            return True
        if path == '/api/admin/payments' and method == 'GET':
            payment_views = []
            for payment in db['payments']:
                if query.get('mode') in {'live', 'test'} and payment.get('test', True) != (query['mode'] == 'test'):
                    continue
                ds = datetime.fromtimestamp(payment['createdAt'] / 1000, MOSCOW).date().isoformat()
                if query.get('from', ds) > ds or query.get('to', ds) < ds or any(query.get(k) and query[k] != payment[k] for k in ['method', 'status']):
                    continue
                view = copy.deepcopy(payment)
                booking = next(b for b in db['bookings'] if b['id'] == payment['bookingId'])
                view['booking'] = {key: booking[key] for key in ['id', 'number', 'name', 'date', 'start', 'dur']}
                payment_views.append(view)
            paid = [p for p in payment_views if p['status'] in {'succeeded', 'refunded', 'partially_refunded', 'requires_review'}]
            gross, refunds = sum(p['amount'] for p in paid), sum(p.get('refunded', 0) for p in paid)
            methods = {}
            for p in paid:
                methods[p['method']] = methods.get(p['method'], 0) + p['amount']
            return dict(list=sorted(payment_views, key=lambda p: -p['createdAt']), totals=dict(count=len(payment_views), gross=gross, refunds=refunds, refundsCount=sum(p.get('refunded', 0) > 0 for p in paid), net=gross - refunds, byMethod=methods))
        if path == '/api/admin/clients' and method == 'GET':
            return self.clients(db, query.get('q', ''))
        if path == '/api/admin/client' and method == 'GET':
            client = next((c for c in self.clients(db) if c['phone'] == query.get('phone')), None)
            if not client:
                raise APIError('NOTFOUND', 'Клиент не найден', 404)
            client.update(history=[booking_view(db, b) for b in db['bookings'] if b['phone'] == client['phone']], profile=None)
            return client
        if path == '/api/admin/dashboard' and method == 'GET':
            return self.dashboard(db)
        raise APIError('NOTFOUND', 'Маршрут не найден', 404)

    @staticmethod
    def clients(db, query=''):
        clients = {}
        today = datetime.now(MOSCOW).date().isoformat()
        for booking in db['bookings']:
            phone = booking['phone']
            client = clients.setdefault(phone, dict(phone=phone, phoneFmt='+' + phone, name=booking['name'], visits=0, bookings=0, sum=0, last=None, next=None, cancels=0, noshow=0, hasCabinet=False))
            client['bookings'] += 1
            if booking['status'] in {'paid', 'noshow', 'refund_partial'} and booking['date'] <= today:
                client['sum'] += booking['amount'] - (booking.get('refundAmount') or 0)
                client['last'] = max(client['last'] or booking['date'], booking['date'])
                client['visits'] += booking['status'] == 'paid'
            if booking['status'] == 'paid' and booking['date'] >= today:
                client['next'] = min(client['next'] or booking['date'], booking['date'])
            client['cancels'] += booking['status'] in {'cancelled', 'refunded'}
            client['noshow'] += booking['status'] == 'noshow'
        query = re.sub(r'[\s()+-]', '', query).lower()
        return sorted([c for c in clients.values() if query in re.sub(r'[\s()+-]', '', c['name'] + c['phone']).lower()], key=lambda c: -c['sum'])

    def dashboard(self, db):
        today = datetime.now(MOSCOW).date()
        td = today.isoformat()
        paid = [b for b in db['bookings'] if b['status'] in {'paid', 'noshow', 'refund_partial'}]
        revenue, counts = {}, {}
        for name, days in [('today', 0), ('week', 6), ('month', 29)]:
            bookings = [b for b in paid if (today - timedelta(days=days)).isoformat() <= b['date'] <= td]
            revenue[name] = sum(b['amount'] - (b.get('refundAmount') or 0) for b in bookings)
            counts[name] = len(bookings)
        counts.update(upcoming=sum(b['status'] == 'paid' and at_ms(b['date'], b['start']) > now_ms() for b in db['bookings']), pending=sum(b['status'] == 'pending' for b in db['bookings']), refundsMonth=sum(b['status'] in {'refunded', 'refund_partial'} and b['date'] >= (today - timedelta(days=29)).isoformat() for b in db['bookings']))
        load_days = []
        for offset in range(-20, 7):
            ds = (today + timedelta(days=offset)).isoformat()
            minutes = sum(b['dur'] for b in paid if b['date'] == ds)
            load_days.append(dict(date=ds, label=checked_date(ds).strftime('%d.%m'), pct=round(minutes / (db['settings']['close'] - db['settings']['open']) * 100), future=offset > 0, today=offset == 0, weekend=checked_date(ds).weekday() >= 5))
        hours = list(range(db['settings']['open'] // 60, (db['settings']['close'] + 59) // 60))
        heat = [[0 for _ in hours] for _ in range(7)]
        for weekday in range(7):
            days = [(today - timedelta(days=i)).isoformat() for i in range(60) if (today - timedelta(days=i)).weekday() == weekday]
            for i, hour in enumerate(hours):
                minutes = sum(max(0, min(b['start'] + b['dur'], hour * 60 + 60) - max(b['start'], hour * 60)) for b in paid if b['date'] in days)
                heat[weekday][i] = round(minutes / (len(days) * 60) * 100)
        clients = self.clients(db)
        month = [b for b in paid if (today - timedelta(days=29)).isoformat() <= b['date'] <= td]
        return dict(revenue=revenue, bookings=counts, avgCheck=round(revenue['month'] / counts['month']) if counts['month'] else 0,
                    partialPending=[booking_view(db, b) for b in db['bookings'] if b['status'] == 'refund_partial' and b.get('refundAmount') is None],
                    loadMonth=round(sum(b['dur'] for b in month) / ((db['settings']['close'] - db['settings']['open']) * 30) * 100),
                    repeatShare=round(sum(c['visits'] > 1 for c in clients) / len(clients) * 100) if clients else 0, clientsTotal=len(clients),
                    loadDays=load_days, heat=heat, heatHours=hours,
                    todayList=[booking_view(db, b) for b in db['bookings'] if b['date'] == td and b['status'] in {'paid', 'pending', 'noshow'}],
                    blocksToday=[b for b in db['blocks'] if b['date'] == td], newReports=0)


def create_server(host='127.0.0.1', port=8767, db_path=None, demo_payments=False, admin_login=None, admin_password=None, payment_provider=None):
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    server.store = Store(db_path or ROOT / '.data' / 'bookings.sqlite3')
    server.demo_payments = demo_payments
    server.admin_login = admin_login if admin_login is not None else os.environ.get('PP_ADMIN_LOGIN', '')
    server.admin_password = admin_password if admin_password is not None else os.environ.get('PP_ADMIN_PASSWORD', '')
    server.allowed_hosts = {f'{host}:{server.server_port}', f'localhost:{server.server_port}', f'127.0.0.1:{server.server_port}'}
    configured_origin = os.environ.get('PP_PUBLIC_ORIGIN', '').rstrip('/')
    origin = urlsplit(configured_origin)
    if configured_origin and (origin.scheme != 'https' or not origin.hostname or origin.path or origin.query or origin.fragment or origin.username):
        raise ValueError('PP_PUBLIC_ORIGIN must be a canonical HTTPS origin without a path')
    if configured_origin:
        server.allowed_hosts.add(origin.netloc)
    server.public_origin = configured_origin
    server.secure_cookie = bool(configured_origin)
    passkey_origin = configured_origin or (f'http://{host}:{server.server_port}' if host in {'127.0.0.1', 'localhost'} else '')
    server.accounts = identity.Accounts(server.store, passkey_origin, origin.hostname if configured_origin else host)
    server.access = access.Access()
    server.payments = payments.Payments(server, at_ms, record, check_range, consume_promo, booking_view, private_booking, server.access)
    if payment_provider is not None:
        server.payments.provider = payment_provider
    return server


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bind', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8767)
    parser.add_argument('--database', type=Path)
    parser.add_argument('--demo-payments', action='store_true', help='Enable explicitly simulated payments, no real money or lock codes')
    args = parser.parse_args()
    httpd = create_server(args.bind, args.port, args.database, args.demo_payments)
    print(f'Ping Point: http://{args.bind}:{httpd.server_port}/1-neon/index.html')
    print('Payment mode: ' + ('DEMO ONLY, no money moves' if args.demo_payments else 'disabled; provider integration required'))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
