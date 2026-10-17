"""Account boundaries exercised via real isolated HTTP sessions."""
import base64
import hashlib
import http.cookiejar
import json
import secrets
import struct
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from urllib.parse import quote
from unittest.mock import patch
from datetime import datetime, timedelta, timezone
from pathlib import Path

import cbor2
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec

import server


def b64(value):
    return base64.urlsafe_b64encode(value).rstrip(b'=').decode()


class IdentityHTTPTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.httpd = server.create_server(port=0, db_path=Path(self.temp.name) / 'test.sqlite3')
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.base = 'http://127.0.0.1:' + str(self.httpd.server_port)
        self.client = self.new_client()
        self.password = secrets.token_urlsafe(18)

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.temp.cleanup()

    def new_client(self):
        return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, path, body=None, client=None, headers=None):
        client = client or self.client
        h = {'Content-Type': 'application/json'}
        if body is not None:
            h['X-PP-CSRF'] = self.call('/api/session', client=client)[1]['csrf']
        h.update(headers or {})
        request = urllib.request.Request(self.base + path, data=json.dumps(body).encode() if body is not None else None, headers=h)
        try:
            with client.open(request) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    def registration(self, **changes):
        docs = self.call('/api/account/documents')[1]['list']
        data = dict(phone='79000000001', name='Игрок теста', password=self.password, ageGroup='adult',
                    consents={d['id']: dict(accepted=True, version=d['version'], hash=d['hash']) for d in docs})
        data.update(changes)
        return data

    def admin(self):
        self.httpd.admin_login = secrets.token_urlsafe(12)
        self.httpd.admin_password = secrets.token_urlsafe(24)
        client = self.new_client()
        self.assertEqual(self.call('/api/admin/login', dict(login=self.httpd.admin_login, password=self.httpd.admin_password), client)[0], 200)
        return client

    def test_registration_consent_password_profile_and_registry(self):
        docs_status, docs = self.call('/api/account/documents')
        self.assertEqual(docs_status, 200, 'Canonical registration documents endpoint is required')
        data = self.registration()
        for invalid in [dict(consents={}), dict(ageGroup=''), dict(password='short'), dict(ageGroup='minor', guardian={})]:
            self.assertEqual(self.call('/api/account/register', dict(data, **invalid))[0], 400)
        old = self.call('/api/session')[1]['csrf']
        status, result = self.call('/api/account/register', data)
        self.assertEqual(status, 200)
        user = result['user']
        self.assertNotEqual(old, result['csrf'])
        self.assertFalse(user['phoneVerified'])
        self.assertTrue(user['docsOk'])
        self.assertEqual(user['phoneRaw'], data['phone'])
        self.assertNotIn('passwordHash', json.dumps(result))
        self.assertEqual(self.call('/api/admin/users')[0], 403)
        admin = self.admin()
        listing = self.call('/api/admin/users?q=' + quote('Игрок') + '&page=1&pageSize=1', client=admin)[1]
        self.assertEqual(listing['total'], 1)
        self.assertEqual(listing['list'][0]['bookingsCount'], 0)
        with self.httpd.store.connect() as conn:
            state = json.loads(conn.execute('SELECT data FROM state').fetchone()[0])
        self.assertNotIn(self.password, json.dumps(state))
        self.assertEqual(len([c for c in state['consents'] if c.get('subjectId') == user['id']]), 3)
        profile = self.call('/api/account/profile', dict(name='Новое имя', admin=True, phone='79000000002'))[1]['user']
        self.assertEqual(profile['name'], 'Новое имя')
        self.assertEqual(profile['phoneRaw'], data['phone'])
        self.assertEqual(self.call('/api/account/profile', dict(about='x'), headers={'X-PP-CSRF': old})[0], 403)

    def test_password_sessions_booking_ownership_and_throttling(self):
        tomorrow = (datetime.now(timezone(timedelta(hours=3))) + timedelta(days=2)).date().isoformat()
        booking_input = dict(date=tomorrow, start=600, dur=60, players=2, rackets=0, name='Гость', phone='79000000001',
                             consents=dict(offer=True, policy=True, consent_pd=True))
        _, own = self.call('/api/bookings', booking_input)
        stranger = self.new_client()
        _, theirs = self.call('/api/bookings', dict(booking_input, start=660), stranger)
        self.assertEqual(self.call('/api/account/register', self.registration())[0], 200)
        second = self.new_client()
        self.assertEqual(self.call('/api/account/login', dict(phone='79000000001', password=self.password), second)[0], 200)
        self.assertEqual(self.call('/api/bookings/' + own['id'], client=second)[0], 200)
        self.assertEqual(self.call('/api/bookings/' + theirs['id'], client=second)[0], 404)
        new_password = secrets.token_urlsafe(18)
        self.assertEqual(self.call('/api/account/password', dict(currentPassword='wrong', newPassword=new_password))[0], 401)
        self.assertEqual(self.call('/api/account/password', dict(currentPassword=self.password, newPassword=new_password))[0], 200)
        self.assertIsNone(self.call('/api/account/me', client=second)[1]['user'])
        self.assertEqual(self.call('/api/account/logout', {})[0], 200)
        self.assertEqual(self.call('/api/bookings/' + own['id'])[0], 404)
        self.assertEqual(self.call('/api/bookings/' + theirs['id'], client=stranger)[0], 200)
        bad_known = self.call('/api/account/login', dict(phone='79000000001', password=self.password))
        bad_unknown = self.call('/api/account/login', dict(phone='79000000999', password=self.password))
        self.assertEqual(bad_known, bad_unknown)
        self.assertEqual(self.call('/api/account/login', dict(phone='79000000001', password=new_password))[0], 200)
        for _ in range(20):
            status, _ = self.call('/api/account/login', dict(phone='79000000001', password='wrong'))
        self.assertEqual(status, 429)

    def registration_credential(self, options, key, credential_id, origin=None, flags=0x45):
        public = key.public_key().public_numbers()
        cose = cbor2.dumps({1: 2, 3: -7, -1: 1, -2: public.x.to_bytes(32, 'big'), -3: public.y.to_bytes(32, 'big')})
        auth = hashlib.sha256(b'127.0.0.1').digest() + bytes([flags]) + struct.pack('>I', 0) + bytes(16) + struct.pack('>H', len(credential_id)) + credential_id + cose
        client = json.dumps(dict(type='webauthn.create', challenge=options['challenge'], origin=origin or self.base)).encode()
        return dict(id=b64(credential_id), rawId=b64(credential_id), type='public-key',
                    response=dict(clientDataJSON=b64(client), attestationObject=b64(cbor2.dumps(dict(fmt='none', authData=auth, attStmt={})))),
                    clientExtensionResults={}, authenticatorAttachment='platform')

    def assertion(self, options, key, credential_id, count=1, origin=None, flags=5):
        auth = hashlib.sha256(b'127.0.0.1').digest() + bytes([flags]) + struct.pack('>I', count)
        client = json.dumps(dict(type='webauthn.get', challenge=options['challenge'], origin=origin or self.base)).encode()
        signature = key.sign(auth + hashlib.sha256(client).digest(), ec.ECDSA(hashes.SHA256()))
        return dict(id=b64(credential_id), rawId=b64(credential_id), type='public-key',
                    response=dict(clientDataJSON=b64(client), authenticatorData=b64(auth), signature=b64(signature)), clientExtensionResults={})

    def test_real_signed_webauthn_registration_and_assertion_boundaries(self):
        self.assertEqual(self.call('/api/account/register', self.registration())[0], 200)
        key, credential_id = ec.generate_private_key(ec.SECP256R1()), secrets.token_bytes(32)
        _, options = self.call('/api/account/passkeys/register/options', {})
        self.assertEqual(options['authenticatorSelection']['userVerification'], 'required')
        bad = self.registration_credential(options, key, credential_id, flags=0x41)
        self.assertEqual(self.call('/api/account/passkeys/register/verify', dict(credential=bad))[0], 401)
        good = self.registration_credential(options, key, credential_id)
        self.assertEqual(self.call('/api/account/passkeys/register/verify', dict(credential=good))[0], 401, 'Failed challenge must still be consumed')
        _, options = self.call('/api/account/passkeys/register/options', {})
        good = self.registration_credential(options, key, credential_id)
        self.assertEqual(self.call('/api/account/passkeys/register/verify', dict(credential=good))[0], 200)
        self.assertEqual(len(self.call('/api/account/passkeys')[1]['list']), 1)
        other = self.new_client()
        self.assertEqual(self.call('/api/account/passkeys', client=other)[0], 401)
        _, options = self.call('/api/account/passkeys/login/options', dict(phone='79000000001'), other)
        signed = self.assertion(options, key, credential_id)
        self.assertEqual(self.call('/api/account/passkeys/login/verify', dict(credential=signed))[0], 401, 'Challenge is cookie-bound')
        bad = self.assertion(options, ec.generate_private_key(ec.SECP256R1()), credential_id)
        self.assertEqual(self.call('/api/account/passkeys/login/verify', dict(credential=bad), other)[0], 401, 'Wrong signing key must fail')
        self.assertEqual(self.call('/api/account/passkeys/login/verify', dict(credential=signed), other)[0], 401)
        _, options = self.call('/api/account/passkeys/login/options', dict(phone='79000000001'), other)
        bad_origin = self.assertion(options, key, credential_id, origin='https://untrusted.invalid')
        self.assertEqual(self.call('/api/account/passkeys/login/verify', dict(credential=bad_origin), other)[0], 401)
        _, options = self.call('/api/account/passkeys/login/options', dict(phone='79000000001'), other)
        signed = self.assertion(options, key, credential_id)
        status, result = self.call('/api/account/passkeys/login/verify', dict(credential=signed), other)
        self.assertEqual(status, 200, result)
        self.assertEqual(result['user']['phoneRaw'], '79000000001')
        _, options = self.call('/api/account/passkeys/login/options', dict(phone='79000000001'), other)
        replay_count = self.assertion(options, key, credential_id)
        self.assertEqual(self.call('/api/account/passkeys/login/verify', dict(credential=replay_count), other)[0], 401)
        self.assertEqual(self.call('/api/account/passkeys/delete', dict(id=b64(credential_id)), other)[0], 200)
        self.assertEqual(self.call('/api/account/passkeys')[1]['list'], [])

    def test_passkey_ttl_rpid_and_document_revision_boundaries(self):
        data = self.registration()
        data['consents']['policy']['hash'] = '0' * 64
        self.assertEqual(self.call('/api/account/register', data)[0], 409)
        self.assertEqual(self.call('/api/account/register', self.registration())[0], 200)
        key, credential_id = ec.generate_private_key(ec.SECP256R1()), secrets.token_bytes(32)
        _, options = self.call('/api/account/passkeys/register/options', {})
        credential = self.registration_credential(options, key, credential_id)
        future = time.time() + 301
        with patch('identity.time.time', return_value=future):
            self.assertEqual(self.call('/api/account/passkeys/register/verify', dict(credential=credential))[0], 401)
        self.assertEqual(self.call('/api/account/passkeys/register/verify', dict(credential=credential))[0], 401)
        _, options = self.call('/api/account/passkeys/register/options', {})
        credential = self.registration_credential(options, key, credential_id)
        attestation = cbor2.loads(base64.urlsafe_b64decode(credential['response']['attestationObject'] + '=='))
        attestation['authData'] = hashlib.sha256(b'untrusted.invalid').digest() + attestation['authData'][32:]
        credential['response']['attestationObject'] = b64(cbor2.dumps(attestation))
        self.assertEqual(self.call('/api/account/passkeys/register/verify', dict(credential=credential))[0], 401)

    def test_additive_migration_and_configured_secure_origin(self):
        # A pre-accounts database and guest session remain intact after an additive open.
        with self.httpd.store.connect() as conn:
            state = json.loads(conn.execute('SELECT data FROM state').fetchone()[0])
            for key in ['users', 'credentials', 'authChallenges', 'refundOperations']:
                state.pop(key, None)
            state['consents'].append(dict(bookingId='legacy', docId='offer', hash='old-revision'))
            conn.execute('UPDATE state SET data=? WHERE id=1', (json.dumps(state),))
        self.assertEqual(self.call('/api/account/me')[1]['user'], None)
        with self.httpd.store.connect() as conn:
            state = json.loads(conn.execute('SELECT data FROM state').fetchone()[0])
        self.assertEqual(state['consents'][0]['hash'], 'old-revision')
        self.assertEqual(state['users'], [])
        with patch.dict('os.environ', {'PP_PUBLIC_ORIGIN': 'https://booking.example.invalid'}):
            configured = server.create_server(port=0, db_path=Path(self.temp.name) / 'secure.sqlite3')
        self.addCleanup(configured.server_close)
        threading.Thread(target=configured.serve_forever, daemon=True).start()
        self.addCleanup(configured.shutdown)
        request = urllib.request.Request('http://127.0.0.1:' + str(configured.server_port) + '/api/session',
                                         headers={'Host': 'booking.example.invalid'})
        with urllib.request.urlopen(request) as response:
            self.assertIn('; Secure', response.headers['Set-Cookie'])
            result = json.load(response)
        self.assertTrue(result['capabilities']['passkeys'])
        self.assertEqual(configured.accounts.origin, 'https://booking.example.invalid')
        self.assertEqual(configured.accounts.rp_id, 'booking.example.invalid')

    def test_password_change_rejects_login_verified_before_revocation(self):
        self.assertEqual(self.call('/api/account/register', self.registration())[0], 200)
        second = self.new_client()
        checked, release = threading.Event(), threading.Event()
        lock = threading.Lock()
        intercepted = False
        original = server.identity.password_matches
        result = []

        def pause_after_verification(password, stored):
            nonlocal intercepted
            valid = original(password, stored)
            with lock:
                pause = valid and not intercepted
                if pause:
                    intercepted = True
            if pause:
                checked.set()
                if not release.wait(10):
                    raise RuntimeError('Race test barrier timed out')
            return valid

        def login():
            result.append(self.call('/api/account/login', dict(phone='79000000001', password=self.password), second))

        with patch('identity.password_matches', side_effect=pause_after_verification):
            thread = threading.Thread(target=login)
            thread.start()
            try:
                self.assertTrue(checked.wait(5))
                changed = self.call('/api/account/password', dict(currentPassword=self.password, newPassword=secrets.token_urlsafe(18)))
                self.assertEqual(changed[0], 200)
            finally:
                release.set()
                thread.join(5)
        self.assertEqual(result[0][0], 401, 'An old verified password must not create a session after revocation')
        self.assertIsNone(self.call('/api/account/me', client=second)[1]['user'])

