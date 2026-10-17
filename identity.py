"""Server accounts and WebAuthn verification. No external authentication service."""
import base64
import copy
import hashlib
import hmac
import json
import re
import secrets
import threading
import time
from pathlib import Path

from webauthn import (generate_authentication_options, generate_registration_options,
                      options_to_json, verify_authentication_response, verify_registration_response)
from webauthn.helpers.structs import (AuthenticatorSelectionCriteria, PublicKeyCredentialDescriptor,
                                    ResidentKeyRequirement, UserVerificationRequirement)

ROOT = Path(__file__).resolve().parent
DOCUMENTS = [('consent_pd', 'soglasie-pd.html', '1.0'),
             ('community_rules', 'pravila-soobshchestva.html', '1.0'),
             ('policy', 'politika.html', '1.0')]


class IdentityError(Exception):
    def __init__(self, code, message, status=400):
        self.code, self.message, self.status = code, message, status


def documents():
    return [dict(id=ident, version=version, hash=hashlib.sha256((ROOT / '1-neon/docs' / file).read_bytes()).hexdigest(),
                 url='/1-neon/docs/' + file) for ident, file, version in DOCUMENTS]


def milliseconds():
    return int(time.time() * 1000)


def encode(value):
    return base64.urlsafe_b64encode(value).rstrip(b'=').decode()


def decode(value):
    return base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))


def phone(value):
    result = re.sub(r'\D', '', str(value or ''))
    if len(result) == 11 and result.startswith('8'):
        result = '7' + result[1:]
    if not re.fullmatch(r'7\d{10}', result):
        raise IdentityError('PHONE', 'Проверьте номер телефона')
    return result


def name(value, lower=2, upper=60):
    if not isinstance(value, str) or not lower <= len(value.strip()) <= upper:
        raise IdentityError('NAME', 'Укажите имя (от 2 до 60 символов)')
    return ' '.join(value.split())


def password_hash(password):
    if not isinstance(password, str) or not 10 <= len(password) <= 128:
        raise IdentityError('PASSWORD', 'Пароль должен содержать от 10 до 128 символов')
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1)
    return dict(algorithm='scrypt', salt=encode(salt), digest=encode(digest), n=16384, r=8, p=1)


def password_matches(password, stored):
    if not isinstance(password, str) or len(password) > 128:
        return False
    digest = hashlib.scrypt(password.encode(), salt=decode(stored['salt']), n=stored['n'], r=stored['r'], p=stored['p'])
    return hmac.compare_digest(digest, decode(stored['digest']))


def consent_records(body):
    supplied = body.get('consents')
    if not isinstance(supplied, dict):
        raise IdentityError('CONSENT', 'Подтвердите документы регистрации')
    result = {}
    for doc in documents():
        item = supplied.get(doc['id'])
        if not isinstance(item, dict) or item.get('accepted') is not True:
            raise IdentityError('CONSENT', 'Подтвердите документы регистрации')
        if item.get('version') != doc['version'] or item.get('hash') != doc['hash']:
            raise IdentityError('DOCS_CHANGED', 'Документы обновились. Откройте их и подтвердите новую редакцию', 409)
        result[doc['id']] = dict(version=doc['version'], hash=doc['hash'], active=True, acceptedAt=milliseconds())
    return result


def profile(user):
    if not user:
        return None
    allowed = ['id', 'name', 'phone', 'createdAt', 'lastLoginAt', 'phoneVerified', 'ageGroup', 'guardian',
               'age', 'level', 'hand', 'style', 'about', 'tg', 'showPhone', 'photo', 'deletion', 'consents']
    result = {key: copy.deepcopy(user.get(key)) for key in allowed}
    result['phoneRaw'] = user['phone']
    result['phone'] = '+' + user['phone']
    result['hasPhoto'] = bool(user.get('photo'))
    result['demo'] = False
    result['outdated'] = [doc['id'] for doc in documents() if user.get('consents', {}).get(doc['id'], {}).get('hash') != doc['hash']]
    result['docsOk'] = not result['outdated'] and all(user.get('consents', {}).get(d['id'], {}).get('active') for d in documents()) and not user.get('deletion')
    result['publicOk'] = False
    result['publicCond'] = None
    fields = [('photo', 'Фото', 25), ('name', 'Имя', 10), ('age', 'Возраст', 10), ('level', 'Уровень', 15),
              ('hand', 'Игровая рука', 10), ('style', 'Стиль игры', 10), ('about', 'О себе', 10), ('tg', 'Telegram', 10)]
    result['completeness'] = dict(pct=sum(weight for key, _, weight in fields if user.get(key)),
                                  missing=[dict(key=key, title=title, add=weight) for key, title, weight in fields if not user.get(key)])
    return result


class RateLimiter:
    """Per-process bounded attempt budget, independent of failed DB transactions."""
    def __init__(self):
        self.lock = threading.Lock()
        self.attempts = {}

    def check(self, scope, peer, login='', limit=20, seconds=900):
        with self.lock:
            now = time.monotonic()
            self.attempts = {key: value for key, value in self.attempts.items() if value[0] > now}
            keys = [(scope, 'ip', peer), (scope, 'login', login)] if login else [(scope, 'ip', peer)]
            for key in keys:
                expires, count = self.attempts.get(key, (now + seconds, 0))
                if count >= limit:
                    raise IdentityError('RATE_LIMIT', 'Слишком много попыток. Повторите через 15 минут', 429)
                self.attempts[key] = (expires, count + 1)


class Accounts:
    def __init__(self, store, origin, rp_id):
        self.store, self.origin, self.rp_id = store, origin, rp_id
        self.limiter = RateLimiter()
        self.dummy_hash = password_hash(secrets.token_urlsafe(32))

    def user(self, db, session, required=False):
        user = next((u for u in db['users'] if u['id'] == session.get('userId')), None)
        if required and not user:
            raise IdentityError('AUTH', 'Войдите в аккаунт', 401)
        return user

    def register(self, body, peer):
        login = phone(body.get('phone'))
        self.limiter.check('register', peer, login, limit=10)
        display = name(body.get('name'))
        accepted = consent_records(body)
        age_group = body.get('ageGroup')
        if age_group not in {'adult', 'minor'}:
            raise IdentityError('AGE', 'Укажите возраст: 18+ или 14–17 с согласия законного представителя')
        guardian = None
        if age_group == 'minor':
            raw = body.get('guardian') or {}
            if not isinstance(raw, dict):
                raise IdentityError('GUARDIAN', 'Укажите законного представителя')
            guardian = dict(fio=name(raw.get('fio'), upper=80), phone=phone(raw.get('phone')))
            if guardian['phone'] == login:
                raise IdentityError('GUARDIAN', 'Укажите телефон законного представителя')
        hashed = password_hash(body.get('password'))
        user = dict(id='u_' + secrets.token_urlsafe(18), name=display, phone=login, passwordHash=hashed,
                    authRevision=0,
                    createdAt=milliseconds(), lastLoginAt=milliseconds(), phoneVerified=False,
                    ageGroup=age_group, guardian=guardian, consents=accepted,
                    age=None, level=None, hand=None, style=None, about='', tg='', showPhone=False, photo=None, deletion=None)
        def save(db):
            if any(u['phone'] == login for u in db['users']):
                raise IdentityError('ACCOUNT_EXISTS', 'Регистрация недоступна. Если у вас есть аккаунт, войдите', 409)
            db['users'].append(user)
            for doc_id, record in accepted.items():
                db['consents'].append(dict(subjectId=user['id'], docId=doc_id, docVersion=record['version'],
                    hash=record['hash'], acceptedAt=record['acceptedAt'], action='accepted', context='registration', guardian=guardian))
            return user
        return self.store.transaction(save)

    def login(self, body, peer):
        try:
            login = phone(body.get('phone'))
        except IdentityError:
            login = ''
        self.limiter.check('login', peer, login, limit=20)
        user = self.store.transaction(lambda db: next((u for u in db['users'] if u['phone'] == login), None))
        valid = password_matches(body.get('password'), user['passwordHash'] if user else self.dummy_hash)
        if not user or not valid:
            raise IdentityError('AUTH', 'Неверный телефон или пароль', 401)
        # Return the exact credential snapshot that was verified. Session creation
        # compares it atomically with the stored revision/hash before granting rights.
        return user

    @staticmethod
    def touch(db, user_id):
        user = next(u for u in db['users'] if u['id'] == user_id)
        user['lastLoginAt'] = milliseconds()
        return user

    def update(self, db, body, session):
        user = self.user(db, session, True)
        if 'name' in body:
            user['name'] = name(body['name'])
        for key, limit in [('about', 600), ('tg', 64)]:
            if key in body:
                if not isinstance(body[key], str) or len(body[key]) > limit:
                    raise IdentityError('VALID', 'Проверьте профиль')
                user[key] = body[key].strip()
        for key, choices in [('level', {'novice', 'amateur', 'confident', 'pro'}),
                             ('hand', {'right', 'left'}), ('style', {'attack', 'defense', 'universal'})]:
            if key in body:
                if body[key] is not None and body[key] not in choices:
                    raise IdentityError('VALID', 'Проверьте профиль')
                user[key] = body[key]
        if 'age' in body:
            value = body['age']
            if value is not None and (type(value) is not int or not 14 <= value <= 100 or (user['ageGroup'] == 'adult' and value < 18)):
                raise IdentityError('AGE', 'Проверьте возраст')
            user['age'] = value
        if 'showPhone' in body:
            if type(body['showPhone']) is not bool:
                raise IdentityError('VALID', 'Проверьте профиль')
            user['showPhone'] = body['showPhone']
        if 'photo' in body:
            photo = body['photo']
            if photo is not None and (not isinstance(photo, str) or len(photo) > 45000 or not re.fullmatch(r'data:image/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+', photo)):
                raise IdentityError('PHOTO', 'Выберите небольшое фото PNG, JPEG или WebP')
            user['photo'] = photo
        return dict(user=profile(user))

    def options(self, db, session, purpose, phone_value=None):
        if not self.origin or not self.rp_id:
            raise IdentityError('PASSKEY_UNAVAILABLE', 'Ключи доступа доступны на HTTPS-сайте после настройки адреса', 503)
        if purpose == 'register':
            user = self.user(db, session, True)
            credentials = [c for c in db['credentials'] if c['userId'] == user['id']]
            options = generate_registration_options(rp_id=self.rp_id, rp_name='Ping Point', user_name=user['phone'],
                user_id=user['id'].encode(), user_display_name=user['name'],
                authenticator_selection=AuthenticatorSelectionCriteria(resident_key=ResidentKeyRequirement.PREFERRED,
                    user_verification=UserVerificationRequirement.REQUIRED),
                exclude_credentials=[PublicKeyCredentialDescriptor(id=decode(c['id'])) for c in credentials])
            user_id = user['id']
        else:
            login = phone(phone_value)
            user = next((u for u in db['users'] if u['phone'] == login), None)
            credentials = [c for c in db['credentials'] if user and c['userId'] == user['id']]
            # An unknown login still receives an impossible descriptor, never a discoverable empty list.
            options = generate_authentication_options(rp_id=self.rp_id,
                allow_credentials=[PublicKeyCredentialDescriptor(id=decode(c['id'])) for c in credentials] or
                                  [PublicKeyCredentialDescriptor(id=secrets.token_bytes(32))],
                user_verification=UserVerificationRequirement.REQUIRED)
            user_id = user['id'] if user else None
        db['authChallenges'] = [c for c in db['authChallenges'] if c['expiresAt'] > milliseconds() and
                                 not (c['sessionId'] == session['id'] and c['purpose'] == purpose)]
        db['authChallenges'].append(dict(sessionId=session['id'], purpose=purpose, userId=user_id,
                                         authRevision=user.get('authRevision', 0) if user else 0,
                                         challenge=encode(options.challenge), expiresAt=milliseconds() + 300000))
        return json.loads(options_to_json(options))

    def verify(self, body, session, purpose):
        def consume(db):
            challenge = next((c for c in db['authChallenges'] if c['sessionId'] == session['id'] and c['purpose'] == purpose), None)
            db['authChallenges'] = [c for c in db['authChallenges'] if c is not challenge]
            return challenge
        challenge = self.store.transaction(consume)  # persist one-use consumption even when verification fails
        if not challenge or challenge['expiresAt'] <= milliseconds() or not challenge['userId']:
            raise IdentityError('PASSKEY', 'Не удалось проверить ключ. Начните вход заново', 401)
        credential = body.get('credential')
        try:
            if purpose == 'register':
                if challenge['userId'] != session.get('userId'):
                    raise ValueError()
                verified = verify_registration_response(credential=credential,
                    expected_challenge=decode(challenge['challenge']), expected_rp_id=self.rp_id,
                    expected_origin=self.origin, require_user_presence=True, require_user_verification=True)
                def save(db):
                    current_user = self.user(db, session, True)
                    if current_user.get('authRevision', 0) != challenge.get('authRevision', 0):
                        raise IdentityError('PASSKEY', 'Аккаунт изменился. Начните заново', 401)
                    ident = encode(verified.credential_id)
                    if any(c['id'] == ident for c in db['credentials']):
                        raise IdentityError('PASSKEY_EXISTS', 'Этот ключ уже добавлен', 409)
                    db['credentials'].append(dict(id=ident, userId=challenge['userId'], publicKey=encode(verified.credential_public_key),
                        signCount=verified.sign_count, createdAt=milliseconds(), name='Ключ устройства'))
                    return dict(ok=True)
                return self.store.transaction(save)
            existing = self.store.transaction(lambda db: next((c for c in db['credentials'] if isinstance(credential, dict) and
                c['id'] == credential.get('id') and c['userId'] == challenge['userId']), None))
            if not existing:
                raise ValueError()
            response = credential.get('response', {})
            handle = response.get('userHandle')
            if handle and decode(handle) != challenge['userId'].encode():
                raise ValueError()
            verified = verify_authentication_response(credential=credential,
                expected_challenge=decode(challenge['challenge']), expected_rp_id=self.rp_id, expected_origin=self.origin,
                credential_public_key=decode(existing['publicKey']), credential_current_sign_count=existing['signCount'],
                require_user_verification=True)
            def update(db):
                current_user = next((u for u in db['users'] if u['id'] == challenge['userId']), None)
                if not current_user or current_user.get('authRevision', 0) != challenge.get('authRevision', 0):
                    raise IdentityError('PASSKEY', 'Аккаунт изменился. Начните вход заново', 401)
                current = next((c for c in db['credentials'] if c['id'] == existing['id'] and c['userId'] == challenge['userId']), None)
                if not current or current['signCount'] != existing['signCount']:
                    raise IdentityError('PASSKEY', 'Ключ изменился. Начните вход заново', 401)
                current['signCount'] = verified.new_sign_count
                return self.touch(db, challenge['userId'])
            return self.store.transaction(update)
        except IdentityError:
            raise
        except Exception:
            raise IdentityError('PASSKEY', 'Не удалось проверить ключ. Начните вход заново', 401) from None
