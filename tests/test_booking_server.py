import http.cookiejar
import importlib.util
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


class BookingServerTest(unittest.TestCase):
    def setUp(self):
        path = ROOT / 'server.py'
        self.assertTrue(path.exists(), 'Shared booking HTTP server has not been implemented')
        spec = importlib.util.spec_from_file_location('booking_server', path)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.temp = tempfile.TemporaryDirectory()
        self.server = self.module.create_server(port=0, db_path=Path(self.temp.name) / 'bookings.sqlite3')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = 'http://127.0.0.1:' + str(self.server.server_port)
        self.client = self.new_client()

    def tearDown(self):
        if hasattr(self, 'server'):
            self.server.shutdown()
            self.server.server_close()
            self.temp.cleanup()

    def new_client(self):
        return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, path, data=None, client=None):
        client = client or self.client
        headers = {'Content-Type': 'application/json'}
        if data is not None:
            _, session = self.call('/api/session', client=client)
            headers['X-PP-CSRF'] = session['csrf']
        req = urllib.request.Request(self.base + path, data=json.dumps(data).encode() if data is not None else None,
                                     headers=headers)
        try:
            with (client or self.client).open(req) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    def test_session_bootstrap_and_private_files(self):
        status, result = self.call('/api/session')
        self.assertEqual(status, 200)
        self.assertEqual(result['settings']['priceAm'], 400)
        self.assertFalse(result['admin'])
        self.assertFalse(result['demoPayments'])
        status, _ = self.call('/.data/bookings.sqlite3')
        self.assertEqual(status, 404)

    def booking(self, start=600, **values):
        tomorrow = (datetime.now(timezone(timedelta(hours=3))) + timedelta(days=2)).date().isoformat()
        return dict(date=tomorrow, start=start, dur=60, players=2, rackets=0,
                    name='Тестовый игрок', phone='+7 900 000 00 00',
                    consents={'offer': True, 'policy': True, 'consent_pd': True}, **values)

    def test_two_independent_clients_conflict_privacy_cancel(self):
        data = self.booking()
        other = self.new_client()
        status, created = self.call('/api/bookings', data)
        self.assertEqual(status, 200)
        self.assertEqual(created['amount'], 400)
        status, public = self.call('/api/availability?date=' + data['date'], client=other)
        self.assertEqual(status, 200)
        self.assertEqual(public['slots'][0], {'start': 600, 'state': 'busy', 'rate': 400})
        self.assertNotIn('phone', json.dumps(public))
        self.assertEqual(self.call('/api/bookings/' + created['id'], client=other)[0], 404)
        self.assertEqual(self.call('/api/bookings/' + created['id'] + '/cancel', {}, other)[0], 404)
        self.assertEqual(self.call('/api/bookings', data, other)[0], 409)
        self.assertEqual(self.call('/api/bookings/' + created['id'] + '/cancel', {})[1]['status'], 'cancelled')
        self.assertEqual(self.call('/api/bookings', data, other)[0], 200)

    def test_concurrent_clients_one_winner_and_validation(self):
        clients = [self.new_client(), self.new_client()]
        for client in clients:
            self.call('/api/session', client=client)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda client: self.call('/api/bookings', self.booking(), client)[0], clients))
        self.assertEqual(sorted(results), [200, 409])
        for changes in [dict(start=601), dict(start=1200), dict(dur=30), dict(date='2026-02-30'), dict(start=float('nan')), dict(players=5), dict(rackets=3)]:
            data = self.booking(900)
            data.update(changes)
            self.assertEqual(self.call('/api/bookings', data)[0], 400, changes)
        data = self.booking(720)
        data['dur'] = 120
        self.assertEqual(self.call('/api/bookings', data)[1]['amount'], 900)

    def test_payment_requires_explicit_demo_and_server_admin(self):
        _, booking = self.call('/api/bookings', self.booking())
        status, _ = self.call('/api/bookings/' + booking['id'] + '/payments', {'method': 'sbp'})
        self.assertEqual(status, 503)
        self.assertEqual(self.call('/api/admin/bookings')[0], 403)
        self.assertEqual(self.call('/api/admin/login', {'login': 'admin', 'password': 'pingpoint'})[0], 403)

    def enable_demo_admin(self):
        self.server.demo_payments = True
        self.server.admin_login = 'test-operator'
        self.server.admin_password = 'isolated-test-credential'
        admin = self.new_client()
        self.assertEqual(self.call('/api/admin/login', {'login': self.server.admin_login, 'password': self.server.admin_password}, admin)[0], 200)
        return admin

    def test_demo_payment_reschedule_and_admin_blocks(self):
        admin = self.enable_demo_admin()
        data = self.booking()
        _, booking = self.call('/api/bookings', data)
        _, payment = self.call('/api/bookings/' + booking['id'] + '/payments', {'method': 'card'})
        self.assertEqual(self.call('/api/payments/' + payment['id'] + '/confirm', {'card': '4000000000000002'})[1]['ok'], False)
        _, payment = self.call('/api/bookings/' + booking['id'] + '/payments', {'method': 'sbp'})
        _, result = self.call('/api/payments/' + payment['id'] + '/confirm', {})
        self.assertTrue(result['ok'])
        self.assertIsNone(result['booking']['code'])
        self.assertTrue(result['booking']['test'])
        self.assertEqual(self.call('/api/bookings/' + booking['id'] + '/reschedule', {'date': data['date'], 'start': 600})[0], 200)
        self.assertEqual(self.call('/api/bookings/' + booking['id'] + '/reschedule', {'date': data['date'], 'start': 900})[0], 400)
        _, block = self.call('/api/admin/blocks/create', {'date': data['date'], 'start': 900, 'end': 960}, admin)
        self.assertIn('block', block)
        self.assertEqual(self.call('/api/bookings', self.booking(900))[0], 409)
        self.assertEqual(self.call('/api/admin/blocks/' + block['block']['id'] + '/delete', {}, admin)[0], 200)
        self.assertEqual(self.call('/api/admin/bookings/' + booking['id'], client=admin)[0], 200)
        self.assertEqual(self.call('/api/admin/bookings/' + booking['id'] + '/move', {'start': 900}, admin)[0], 200)
        self.assertEqual(self.call('/api/admin/dashboard', client=admin)[0], 200)
        self.assertEqual(self.call('/api/admin/payments', client=admin)[1]['totals']['gross'], 500)
        self.assertEqual(self.call('/api/admin/logout', {}, admin)[0], 200)
        self.assertEqual(self.call('/api/admin/bookings', client=admin)[0], 403)

    def test_expiry_persistence_and_reschedule_conflict(self):
        admin = self.enable_demo_admin()
        data = self.booking()
        _, booking = self.call('/api/bookings', data)
        with patch.object(self.module.time, 'time', return_value=self.module.time.time() + 901):
            self.assertEqual(self.call('/api/bookings/' + booking['id'])[1]['status'], 'expired')
            self.assertEqual(self.call('/api/availability?date=' + data['date'])[1]['slots'][0]['state'], 'free')
        _, first = self.call('/api/admin/bookings/create', dict(data, pay='cash'), admin)
        self.assertEqual(first['status'], 'paid')
        self.assertEqual(self.call('/api/bookings', self.booking(900))[0], 200)
        self.assertEqual(self.call('/api/admin/bookings/' + first['id'] + '/move', {'start': 900}, admin)[0], 409)
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.server = self.module.create_server(port=int(self.base.rsplit(':', 1)[1]), db_path=Path(self.temp.name) / 'bookings.sqlite3')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.assertEqual(self.call('/api/admin/bookings/' + first['id'], client=admin)[1]['status'], 'paid')
        public = self.call('/api/availability?date=' + data['date'])[1]
        self.assertEqual(public['slots'][0]['state'], 'busy')
        self.assertEqual(self.call('/api/admin/bookings/' + first['id'] + '/cancel', {'withRefund': True}, admin)[1]['status'], 'refunded')

    def test_csrf_ownership_payment_replay_and_admin_configuration(self):
        admin = self.enable_demo_admin()
        other = self.new_client()
        data = self.booking()
        _, booking = self.call('/api/bookings', data)
        forged = urllib.request.Request(self.base + '/api/bookings/' + booking['id'] + '/cancel', data=b'{}', headers={'Content-Type': 'application/json'})
        with self.assertRaises(urllib.error.HTTPError) as raised:
            self.client.open(forged)
        self.assertEqual(raised.exception.code, 403)
        for action in ['payments', 'reschedule', 'reschedule-quote', 'cancel']:
            self.assertEqual(self.call('/api/bookings/' + booking['id'] + '/' + action,
                                       {'phone': data['phone'], 'userId': 'admin', 'admin': True, 'date': data['date'], 'start': 600}, other)[0], 404)
        _, stale = self.call('/api/bookings/' + booking['id'] + '/payments', {'method': 'sbp'})
        _, latest = self.call('/api/bookings/' + booking['id'] + '/payments', {'method': 'sbp'})
        self.assertEqual(self.call('/api/payments/' + stale['id'] + '/confirm', {})[0], 400)
        self.assertEqual(self.call('/api/payments/' + latest['id'] + '/confirm', {}, other)[0], 404)
        self.assertTrue(self.call('/api/payments/' + latest['id'] + '/confirm', {})[1]['ok'])
        self.assertEqual(self.call('/api/payments/' + latest['id'] + '/confirm', {})[0], 400)
        self.assertEqual(self.call('/api/admin/settings', {'priceAm': 500}, other)[0], 403)
        self.assertEqual(self.call('/api/admin/settings', {'priceAm': 420, 'pricePm': 520}, admin)[0], 200)
        self.assertEqual(self.call('/api/bookings', self.booking(720))[1]['amount'], 420)
        self.assertEqual(self.call('/api/admin/promos/save', {'code': 'TEST10', 'type': 'pct', 'value': 10, 'limit': 1}, admin)[0], 200)
        self.assertEqual(self.call('/api/promos/apply', {'code': 'TEST10', 'start': 900, 'dur': 60})[1]['total'], 468)

    def test_past_and_lead_states_follow_moscow_not_system_timezone(self):
        ds = (datetime.now(timezone(timedelta(hours=3))) + timedelta(days=1)).date().isoformat()
        _, booking = self.call('/api/bookings', dict(self.booking(), date=ds))
        _, bootstrap = self.call('/api/session')
        self.assertFalse(bootstrap['demoPayments'])
        # 09:30 Moscow = 06:30 UTC: 10:00 is too close; 10:30 is exactly one hour away.
        clock = datetime.fromisoformat(ds + 'T06:30:00+00:00').timestamp()
        with patch.object(self.module.time, 'time', return_value=clock):
            status, public = self.call('/api/availability?date=' + ds)
            self.assertEqual(status, 200)
            self.assertEqual(public['slots'][0]['state'], 'past')
            self.assertEqual(public['slots'][1]['state'], 'free')
            self.assertEqual(self.call('/api/bookings', dict(self.booking(), date=ds))[0], 400)

    def test_promo_limit_is_atomic_at_payment_for_independent_holds(self):
        admin = self.enable_demo_admin()
        self.call('/api/admin/promos/save', {'code': 'ONEUSE', 'type': 'pct', 'value': 10, 'limit': 1}, admin)
        clients = [self.client, self.new_client()]
        payments = []
        for start, client in zip([600, 900], clients):
            status, booking = self.call('/api/bookings', dict(self.booking(start), promo='ONEUSE'), client)
            self.assertEqual(status, 200)
            status, payment = self.call('/api/bookings/' + booking['id'] + '/payments', {'method': 'sbp'}, client)
            self.assertEqual(status, 200)
            payments.append(payment)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda item: self.call('/api/payments/' + item[1]['id'] + '/confirm', {}, item[0]), zip(clients, payments)))
        self.assertEqual(sorted(status for status, _ in results), [200, 400])
        failure = next(value for status, value in results if status == 400)
        self.assertEqual(failure['error']['code'], 'PROMO')
        promos = self.call('/api/admin/promos', client=admin)[1]
        self.assertEqual(promos[0]['used'], 1)

    def test_paid_promo_transfer_preserves_granted_terms_after_exhaustion_and_edit(self):
        admin = self.enable_demo_admin()
        self.call('/api/admin/promos/save', {'code': 'ONCE10', 'type': 'pct', 'value': 10, 'limit': 1}, admin)
        _, booking = self.call('/api/bookings', dict(self.booking(), promo='ONCE10'))
        _, payment = self.call('/api/bookings/' + booking['id'] + '/payments', {'method': 'sbp'})
        self.assertTrue(self.call('/api/payments/' + payment['id'] + '/confirm', {})[1]['ok'])
        status, quote = self.call('/api/bookings/' + booking['id'] + '/reschedule-quote', {'start': 900})
        self.assertEqual(status, 200, quote)
        self.assertEqual(quote, {'oldAmount': 360, 'newAmount': 450, 'diff': 90})
        self.call('/api/admin/promos/save', {'code': 'ONCE10', 'type': 'rub', 'value': 100, 'limit': 1, 'active': False}, admin)
        status, result = self.call('/api/bookings/' + booking['id'] + '/reschedule', {'start': 900})
        self.assertEqual(status, 200, result)
        self.assertEqual(result['booking']['amount'], 450)
        self.assertEqual(result['diff'], 90)
        self.assertEqual(self.call('/api/admin/promos', client=admin)[1][0]['used'], 1)

    def test_admin_payment_paths_share_promo_consumption(self):
        admin = self.enable_demo_admin()
        self.call('/api/admin/promos/save', {'code': 'STAFFONE', 'type': 'rub', 'value': 100, 'limit': 1}, admin)
        _, held = self.call('/api/bookings', dict(self.booking(), promo='STAFFONE'))
        _, manual = self.call('/api/admin/bookings/create', dict(self.booking(900), promo='STAFFONE', pay='cash'), admin)
        self.assertEqual(manual['status'], 'paid')
        status, value = self.call('/api/admin/bookings/' + held['id'] + '/manual-payment', {'method': 'cash'}, admin)
        self.assertEqual(status, 400, value)
        self.assertEqual(value['error']['code'], 'PROMO')
        self.assertEqual(self.call('/api/admin/promos', client=admin)[1][0]['used'], 1)


if __name__ == '__main__':
    unittest.main()
