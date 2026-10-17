"""Public HTTP integration against a local HTTP YooKassa double, never the real service."""
import copy
from datetime import datetime, timezone
import http.cookiejar
import io
import json
import secrets
import threading
import unittest
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import test_booking_server as fixtures
import payments


class MockProvider(payments.YooKassa):
    def __init__(self, url, test=False):
        super().__init__()
        self.shop_id = self.secret = ''  # The local double never consumes process merchant credentials.
        self.base_url, self.mode, self.origin, self.receipt_mode = url, 'test' if test else 'live', 'https://merchant.example', 'external'

    def readiness(self):
        return dict(configured=True, mode=self.mode, missing=[], message='Isolated HTTP fixture')


class ProviderHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        with self.server.lock:
            self.server.reads.append(self.path)
            result = copy.deepcopy(self.server.objects[self.path])
        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps(result).encode())

    def do_POST(self):
        params = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        key = self.headers['Idempotence-Key']
        with self.server.lock:
            self.server.calls.append((self.path, key, params))
            if key not in self.server.keys:
                ident = secrets.token_hex(12)
                obj = dict(id=ident, amount=params['amount'], status='pending', created_at='2026-10-17T00:00:00Z')
                if self.path == '/payments':
                    obj.update(metadata=params['metadata'], test=self.server.test, paid=False,
                               confirmation=dict(confirmation_url='https://checkout.example/' + ident))
                else:
                    obj['payment_id'] = params['payment_id']
                self.server.keys[key] = self.path + '/' + ident
                self.server.objects[self.path + '/' + ident] = obj
            result = copy.deepcopy(self.server.objects[self.server.keys[key]])
            drop, self.server.drop = self.server.drop, False
        if getattr(self.server, 'on_request', None):
            self.server.on_request()
        if drop:
            self.connection.close()
            return
        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps(result).encode())


class PaymentIntegrationTest(unittest.TestCase):
    setUpBase = fixtures.BookingServerTest.setUp
    tearDownBase = fixtures.BookingServerTest.tearDown
    call = fixtures.BookingServerTest.call
    booking = fixtures.BookingServerTest.booking
    new_client = fixtures.BookingServerTest.new_client

    def setUp(self):
        self.setUpBase()
        self.provider_http = ThreadingHTTPServer(('127.0.0.1', 0), ProviderHandler)
        self.provider_http.objects, self.provider_http.keys, self.provider_http.calls = {}, {}, []
        self.provider_http.reads = []
        self.provider_http.lock = threading.Lock()
        self.provider_http.test, self.provider_http.drop = False, False
        threading.Thread(target=self.provider_http.serve_forever, daemon=True).start()
        self.provider = MockProvider('http://127.0.0.1:' + str(self.provider_http.server_port))
        self.server.payments.provider = self.provider
        self.server.access.device_token = secrets.token_urlsafe(32)
        self.server.access.door_id = 'room-fixture'

    def tearDown(self):
        self.provider_http.shutdown()
        self.provider_http.server_close()
        self.tearDownBase()

    def create_payment(self, start=600, client=None):
        status, booking = self.call('/api/bookings', self.booking(start), client)
        self.assertEqual(status, 200)
        status, payment = self.call('/api/bookings/' + booking['id'] + '/payments', {}, client)
        self.assertEqual(status, 200, payment)
        return booking, payment

    def succeed(self, payment):
        obj = self.provider_http.objects['/payments/' + payment['providerId']]
        obj.update(status='succeeded', paid=True, captured_at='2026-10-17T08:00:00Z', payment_method=dict(type='bank_card'))
        status, result = self.call('/api/payments/' + payment['id'] + '/refresh', {})
        self.assertEqual(status, 200, result)
        return result

    def raw_post(self, path, body, headers=None):
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode(), headers={'Content-Type':'application/json', **(headers or {})})
        try:
            with urllib.request.urlopen(req) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    def test_disabled_is_explicit_and_webhook_not_csrf(self):
        self.server.payments.provider = payments.YooKassa()
        self.assertEqual(self.call('/api/session')[1]['capabilities']['payments'], 'disabled')
        self.assertEqual(self.raw_post('/api/yookassa/webhook', {'event':'payment.succeeded','object':{'id':'unknown'}}), (200, {'ok':True}))

    def test_payment_retry_race_restart_and_timeout_have_one_durable_key(self):
        self.provider_http.drop = True
        _, booking = self.call('/api/bookings', self.booking())
        self.assertEqual(self.call('/api/bookings/' + booking['id'] + '/payments', {})[0], 503)
        self.server.store = self.module.Store(self.server.store.path)
        self.server.payments.store = self.server.store
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _:self.call('/api/bookings/' + booking['id'] + '/payments', {}), range(2)))
        self.assertEqual([r[0] for r in results], [200,200])
        self.assertEqual(len(self.provider_http.keys), 1)
        self.assertEqual(len({json.dumps(c[2], sort_keys=True) for c in self.provider_http.calls}), 1)
        self.assertEqual(results[0][1]['id'], results[1][1]['id'])
        self.assertEqual(self.provider_http.calls[0][2]['amount'], {'value':'400.00','currency':'RUB'})
        other = self.new_client()
        self.assertEqual(self.call('/api/payments/' + results[0][1]['id'] + '/refresh', {}, other)[0], 404)

    def test_provider_io_releases_write_lock_and_account_owns_paid_qr_on_second_device(self):
        docs = self.call('/api/account/documents')[1]['list']
        password = secrets.token_urlsafe(20)
        registration = dict(phone='79000000099',name='Игрок теста',password=password,ageGroup='adult',
            consents={d['id']:dict(accepted=True,version=d['version'],hash=d['hash']) for d in docs})
        self.assertEqual(self.call('/api/account/register',registration)[0],200)
        # This separate HTTP handler can enter a write transaction while provider
        # create is blocked here; holding SQLite around external HTTP would deadlock.
        writes = []
        self.provider_http.on_request = lambda: writes.append(self.server.store.transaction(lambda db:len(db['payments'])))
        booking,payment = self.create_payment()
        self.assertEqual(writes,[1])
        self.succeed(payment)
        other = self.new_client()
        self.assertEqual(self.call('/api/account/login',{'phone':registration['phone'],'password':password},other)[0],200)
        first = self.call('/api/bookings/' + booking['id'] + '/access')[1]
        second = self.call('/api/bookings/' + booking['id'] + '/access',client=other)[1]
        self.assertEqual(first['qrPayload'],second['qrPayload'])

    def test_canonical_verification_duplicate_webhook_and_no_fake_confirmation(self):
        booking, payment = self.create_payment()
        webhook = {'event':'payment.succeeded','object':{'id':payment['providerId'], 'status':'succeeded','paid':True}}
        self.assertEqual(self.raw_post('/api/yookassa/webhook', webhook)[0], 200)
        self.assertEqual(self.call('/api/bookings/' + booking['id'])[1]['status'], 'pending')
        obj = self.provider_http.objects['/payments/' + payment['providerId']]
        obj.update(status='succeeded', paid=True, test=True)
        self.assertEqual(self.call('/api/payments/' + payment['id'] + '/refresh', {})[0],409)
        obj['test'] = False
        obj['amount']['value'] = '1.00'
        self.assertEqual(self.call('/api/payments/' + payment['id'] + '/refresh', {})[0],409)
        obj['amount']['value'] = '400.00'
        obj['metadata']['bookingId'] = 'forged'
        self.assertEqual(self.call('/api/payments/' + payment['id'] + '/refresh', {})[0],409)
        obj['metadata']['bookingId'] = booking['id']
        first = self.succeed(payment)
        for _ in range(2):
            self.assertEqual(self.raw_post('/api/yookassa/webhook', webhook)[0], 200)
        self.assertEqual(self.call('/api/bookings/' + booking['id'])[1]['payment']['paidAt'], first['payment']['paidAt'])
        self.assertEqual(self.server.store.transaction(lambda db:len(db['accessGrants'])), 1)
        self.server.demo_payments = True
        self.assertEqual(self.call('/api/payments/' + payment['id'] + '/confirm', {})[0],409)

    def test_unknown_operation_after_24_hours_is_not_resubmitted(self):
        self.provider_http.drop = True
        _, booking = self.call('/api/bookings', self.booking())
        self.call('/api/bookings/' + booking['id'] + '/payments', {})
        self.server.store.transaction(lambda db: db['paymentOperations'][0].update(createdAt=0))
        self.assertEqual(self.call('/api/bookings/' + booking['id'] + '/payments', {})[0],409)
        self.assertEqual(len(self.provider_http.calls),1)

    def test_changed_merchant_or_mode_never_retries_unknown_payment_or_refund(self):
        self.provider_http.drop = True
        _,booking = self.call('/api/bookings',self.booking())
        self.assertEqual(self.call('/api/bookings/' + booking['id'] + '/payments',{})[0],503)
        first_id = next(iter(self.provider_http.objects.values()))['id']
        calls = len(self.provider_http.calls)
        for attr,value in [('shop_id','different-fixture-shop'),('mode','test')]:
            previous = getattr(self.provider,attr)
            setattr(self.provider,attr,value)
            self.assertEqual(self.call('/api/bookings/' + booking['id'] + '/payments',{})[0],409)
            # Recovery of an unknown ID must not issue GET with the wrong merchant either.
            self.assertEqual(self.raw_post('/api/yookassa/webhook',{'event':'payment.succeeded','object':{'id':first_id}})[0],409)
            self.assertEqual(len(self.provider_http.calls),calls)
            self.assertEqual(self.provider_http.reads,[])
            setattr(self.provider,attr,previous)
        status,payment = self.call('/api/bookings/' + booking['id'] + '/payments',{})
        self.assertEqual(status,200)
        self.succeed(payment)
        self.provider_http.drop = True
        self.assertEqual(self.call('/api/bookings/' + booking['id'] + '/cancel',{})[0],503)
        calls = len(self.provider_http.calls)
        reads = len(self.provider_http.reads)
        self.provider.shop_id = 'different-fixture-shop'
        self.assertEqual(self.call('/api/bookings/' + booking['id'] + '/cancel',{})[0],409)
        self.assertEqual(self.call('/api/payments/' + payment['id'] + '/refresh',{})[0],409)
        self.assertEqual(len(self.provider_http.calls),calls)
        self.assertEqual(len(self.provider_http.reads),reads)

    def test_refund_uses_confirmation_date_and_preserves_it_on_duplicate(self):
        booking,payment = self.create_payment()
        self.succeed(payment)
        self.assertEqual(self.call('/api/bookings/' + booking['id'] + '/cancel',{})[0],200)
        refund = next(v for k,v in self.provider_http.objects.items() if k.startswith('/refunds/'))
        refund.update(status='succeeded',created_at='2026-10-16T10:00:00Z')
        confirmed = int(datetime(2026,10,17,10,tzinfo=timezone.utc).timestamp()*1000)
        with patch.object(self.server.payments,'now',return_value=confirmed):
            self.assertEqual(self.raw_post('/api/yookassa/webhook',{'event':'refund.succeeded','object':{'id':refund['id']}})[0],200)
        self.assertEqual(self.server.store.transaction(lambda db:db['refundOperations'][0]['succeededAt']),confirmed)
        with patch.object(self.server.payments,'now',return_value=confirmed+86400000):
            self.assertEqual(self.raw_post('/api/yookassa/webhook',{'event':'refund.succeeded','object':{'id':refund['id']}})[0],200)
        self.assertEqual(self.server.store.transaction(lambda db:db['refundOperations'][0]['succeededAt']),confirmed)
        self.server.admin_login,self.server.admin_password = secrets.token_hex(8),secrets.token_urlsafe(24)
        admin = self.new_client()
        self.assertEqual(self.call('/api/admin/login',{'login':self.server.admin_login,'password':self.server.admin_password},admin)[0],200)
        rows = self.call('/api/admin/analytics?from=2026-10-16&to=2026-10-17&mode=live',client=admin)[1]['series']
        self.assertEqual([r['refunds'] for r in rows],[0,400])

    def test_webhook_recovers_capture_before_create_response_is_persisted(self):
        self.provider_http.drop = True
        _, booking = self.call('/api/bookings', self.booking())
        self.assertEqual(self.call('/api/bookings/' + booking['id'] + '/payments', {})[0],503)
        obj = next(iter(self.provider_http.objects.values()))
        obj.update(status='succeeded',paid=True)
        status, result = self.raw_post('/api/yookassa/webhook', {'event':'payment.succeeded','object':{'id':obj['id']}})
        self.assertEqual(status,200,result)
        self.assertEqual(self.call('/api/bookings/' + booking['id'])[1]['status'],'paid')

    def test_late_success_conflict_is_money_without_room_access(self):
        booking, payment = self.create_payment()
        self.server.store.transaction(lambda db:db['bookings'][0].update(expiresAt=1))
        self.assertEqual(self.call('/api/bookings', self.booking(), self.new_client())[0],200)
        result = self.succeed(payment)
        self.assertEqual(result['payment']['status'],'requires_review')
        self.assertEqual(result['booking']['status'],'payment_review')
        self.assertNotIn('qrSvg', self.call('/api/bookings/' + booking['id'] + '/access')[1])

    def test_refund_pending_succeeded_duplicate_and_money_event(self):
        booking, payment = self.create_payment()
        self.succeed(payment)
        self.assertEqual(self.call('/api/bookings/' + booking['id'] + '/partial-refund', {'amount':10})[0],403)
        status, result = self.call('/api/bookings/' + booking['id'] + '/cancel', {})
        self.assertEqual(status,200,result)
        self.assertEqual(result['status'],'refund_pending')
        self.assertEqual(result['payment']['status'],'succeeded')
        self.assertNotIn('qrPayload',self.call('/api/bookings/' + booking['id'] + '/access')[1])
        refund = next(v for k,v in self.provider_http.objects.items() if k.startswith('/refunds/'))
        refund['status'] = 'succeeded'
        for _ in range(2):
            self.assertEqual(self.raw_post('/api/yookassa/webhook', {'event':'refund.succeeded','object':{'id':refund['id']}})[0],200)
        result = self.call('/api/bookings/' + booking['id'])[1]
        self.assertEqual(result['payment']['refunded'],400)
        self.assertEqual(result['status'],'refunded')
        self.assertEqual(self.server.store.transaction(lambda db:len(db['refundOperations'])),1)
        # An older pending provider response cannot roll back captured money/refund.
        self.provider_http.objects['/payments/' + payment['providerId']]['status']='pending'
        self.call('/api/payments/' + payment['id'] + '/refresh',{})
        self.assertEqual(self.call('/api/bookings/' + booking['id'])[1]['payment']['status'],'refunded')
