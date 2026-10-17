"""Admin cash analytics: provider event dates, kopecks, timezone and isolation."""
import json
import secrets
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from pathlib import Path

import test_identity


class AnalyticsHTTPTest(test_identity.IdentityHTTPTest):
    # Only the focused analytics cases run in this subclass.
    test_registration_consent_password_profile_and_registry = None
    test_password_sessions_booking_ownership_and_throttling = None
    test_real_signed_webauthn_registration_and_assertion_boundaries = None
    test_passkey_ttl_rpid_and_document_revision_boundaries = None
    test_additive_migration_and_configured_secure_origin = None
    test_password_change_rejects_login_verified_before_revocation = None

    def test_event_dates_kopecks_zero_fill_and_test_segregation(self):
        self.assertEqual(self.call('/api/admin/analytics?from=2026-10-01&to=2026-10-03')[0], 403)
        admin = self.admin()
        def timestamp(value):
            return int(datetime.fromisoformat(value).timestamp() * 1000)
        def fixture(db):
            db['users'] = [dict(id='u1', name='Sample', phone='79000000001', createdAt=timestamp('2026-09-30T21:30:00+00:00'))]
            db['bookings'] = [dict(id='b1', userId='u1', date='2026-11-01', start=600, dur=60, status='paid',
                createdAt=timestamp('2026-10-01T20:00:00+00:00'), history=[], amount=100.11)]
            db['payments'] = [dict(id='p1', bookingId='b1', amount=100.11, method='card', status='partially_refunded', test=False,
                createdAt=timestamp('2026-09-29T00:00:00+00:00'), paidAt=timestamp('2026-10-01T21:01:00+00:00'), refunded=30.03,
                refundedAt=timestamp('2026-10-03T00:00:00+00:00')),
                dict(id='p2', bookingId='b1', amount=999, method='sbp', status='succeeded', test=True,
                createdAt=timestamp('2026-10-01T00:00:00+00:00'), paidAt=timestamp('2026-10-01T00:00:00+00:00')),
                dict(id='p3', bookingId='b1', amount=500, method='card', status='pending', test=False,
                createdAt=timestamp('2026-10-01T00:00:00+00:00'), paidAt=None)]
            db['refundOperations'] = [dict(id='r1', paymentId='p1', amount=10.01, status='succeeded',
                succeededAt=timestamp('2026-10-02T12:00:00+00:00')),
                dict(id='r2', paymentId='p1', amount=20.02, status='succeeded', succeededAt=timestamp('2026-10-03T12:00:00+00:00')),
                dict(id='r3', paymentId='p1', amount=60, status='pending', createdAt=timestamp('2026-10-03T12:00:00+00:00'))]
        self.httpd.store.transaction(fixture)
        status, result = self.call('/api/admin/analytics?from=2026-10-01&to=2026-10-03', client=admin)
        self.assertEqual(status, 200, 'Authenticated cash analytics endpoint is required')
        self.assertEqual(result['timezone'], 'Europe/Moscow')
        self.assertEqual(result['totals'], dict(users=1, newUsers=1, bookings=1, payments=1, gross=100.11, refunds=30.03, net=70.08))
        self.assertEqual(len(result['series']), 3)
        self.assertEqual(result['series'][0]['gross'], 0)
        self.assertEqual(result['series'][1]['gross'], 100.11)
        self.assertEqual(result['series'][2]['refunds'], 20.02)
        self.assertEqual(result['methods'], [dict(method='card', count=1, amount=100.11)])
        test = self.call('/api/admin/analytics?from=2026-10-01&to=2026-10-03&mode=test', client=admin)[1]
        self.assertEqual(test['totals']['gross'], 999)
        self.assertEqual(test['totals']['refunds'], 0)
        for suffix in ['from=2026-10-03&to=2026-10-01', 'from=2020-01-01&to=2026-10-03', 'from=bad&to=2026-10-03', 'mode=anything']:
            self.assertEqual(self.call('/api/admin/analytics?' + suffix, client=admin)[0], 400)

    def test_integrations_and_real_users_not_browser_seed_data(self):
        admin = self.admin()
        status, data = self.call('/api/admin/integrations', client=admin)
        self.assertEqual(status, 200, 'Integration configuration must be honestly visible')
        self.assertFalse(data['payments']['configured'])
        self.assertFalse(data['access']['configured'])
        self.assertTrue(data['passkeys']['configured'])
        self.assertEqual(self.call('/api/admin/access-events', client=admin)[1], dict(list=[], total=0))
        self.assertNotIn(self.httpd.admin_password, json.dumps(data))
        self.assertEqual(self.call('/api/admin/users', client=admin)[1]['total'], 0)

    def test_user_totals_only_confirmed_statuses_and_integer_kopecks(self):
        self.assertEqual(self.call('/api/account/register', self.registration())[0], 200)
        user_id = self.call('/api/account/me')[1]['user']['id']
        admin = self.admin()

        def fixture(db):
            db['bookings'].append(dict(id='ledger', userId=user_id, status='paid'))
            db['payments'] = [dict(id='failed', bookingId='ledger', amount=0.1, method='card', status='failed', paidAt=1, test=False),
                              dict(id='paid', bookingId='ledger', amount=0.2, method='card', status='succeeded', paidAt=1, test=False)]
        self.httpd.store.transaction(fixture)
        user = self.call('/api/admin/users', client=admin)[1]['list'][0]
        self.assertEqual((user['paidCount'], user['totalPaid']), (1, 0.2))
        def add_confirmed(db):
            db['payments'].append(dict(id='paid2', bookingId='ledger', amount=0.1, method='card', status='succeeded', paidAt=1, test=False))
        self.httpd.store.transaction(add_confirmed)
        user = self.call('/api/admin/users', client=admin)[1]['list'][0]
        self.assertEqual((user['paidCount'], user['totalPaid']), (2, 0.3))

