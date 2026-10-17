"""Actual generated SVG is rasterized from its path, then independently decoded by OpenCV."""
import json
import re
import secrets
import unittest
import xml.etree.ElementTree as ET
from unittest.mock import patch

import test_payments as provider_tests


class AccessIntegrationTest(unittest.TestCase):
    setUpBase = provider_tests.PaymentIntegrationTest.setUpBase
    tearDownBase = provider_tests.PaymentIntegrationTest.tearDownBase
    setUp = provider_tests.PaymentIntegrationTest.setUp
    tearDown = provider_tests.PaymentIntegrationTest.tearDown
    call = provider_tests.PaymentIntegrationTest.call
    booking = provider_tests.PaymentIntegrationTest.booking
    new_client = provider_tests.PaymentIntegrationTest.new_client
    create_payment = provider_tests.PaymentIntegrationTest.create_payment
    succeed = provider_tests.PaymentIntegrationTest.succeed
    raw_post = provider_tests.PaymentIntegrationTest.raw_post

    def scan(self, payload, door=None, auth=True):
        headers = {'Authorization':'Bearer ' + self.server.access.device_token} if auth else {}
        return self.raw_post('/api/access/verify', {'payload':payload,'doorId':door or self.server.access.door_id}, headers)

    def admin(self):
        client = self.new_client()
        self.server.admin_login, self.server.admin_password = secrets.token_hex(8), secrets.token_urlsafe(24)
        self.assertEqual(self.call('/api/admin/login', {'login':self.server.admin_login,'password':self.server.admin_password}, client)[0],200)
        return client

    def test_reader_is_fail_closed_and_guest_has_no_qr(self):
        status, booking = self.call('/api/bookings', self.booking())
        self.assertEqual(status, 200)
        status, result = self.call('/api/bookings/' + booking['id'] + '/access')
        self.assertEqual(status, 200)
        self.assertEqual(result['status'], 'unavailable')
        self.assertNotIn('qrPayload', result)
        self.assertEqual(self.scan('forged',auth=False)[0],403)
        self.assertEqual(self.scan('forged',door='wrong-door')[0],403)
        self.assertFalse(self.scan('forged')[1]['allowed'])
        self.server.access.device_token = ''
        self.assertEqual(self.scan('forged')[0],403)

    def test_actual_svg_decodes_and_only_owner_sees_payload(self):
        import cv2
        import numpy as np
        from PIL import Image, ImageDraw
        booking, payment = self.create_payment()
        self.succeed(payment)
        url = '/api/bookings/' + booking['id'] + '/access'
        status, result = self.call(url)
        self.assertEqual(status,200)
        self.assertEqual(result['status'],'scheduled')
        self.assertEqual(self.call(url,client=self.new_client())[0],404)
        svg = ET.fromstring(result['qrSvg'])
        width = float(svg.attrib['viewBox'].split()[2])
        image = Image.new('RGB',(round(width*12),round(width*12)),'white')
        draw = ImageDraw.Draw(image)
        path = svg.find('{http://www.w3.org/2000/svg}path').attrib['d']
        # SvgPathImage emits closed rectangular subpaths. Render the actual API SVG.
        rectangles = re.findall(r'M([\d.]+),([\d.]+)H([\d.]+)V([\d.]+)H([\d.]+)z',path)
        self.assertGreater(len(rectangles),100)
        for x,y,right,bottom,_ in rectangles:
            draw.rectangle((round(float(x)*12),round(float(y)*12),round(float(right)*12)-1,round(float(bottom)*12)-1), fill='black')
        decoded, _, _ = cv2.QRCodeDetector().detectAndDecode(np.asarray(image))
        self.assertEqual(decoded,result['qrPayload'])
        self.assertGreaterEqual(len(decoded),43)
        regular = self.call('/api/bookings/mine')[1]
        self.assertNotIn(result['qrPayload'],json.dumps(regular))
        self.assertNotIn('qrSvg',json.dumps(regular))
        self.server.store = self.module.Store(self.server.store.path)
        self.server.payments.store = self.server.store
        self.assertEqual(self.call(url)[1]['qrPayload'],decoded)
        admin = self.admin()
        events = self.call('/api/admin/access-events',client=admin)[1]
        self.assertNotIn(result['qrPayload'],json.dumps(events))

    def test_exact_interval_multiple_entries_revocation_and_redacted_events(self):
        booking, payment = self.create_payment()
        self.succeed(payment)
        access = self.call('/api/bookings/' + booking['id'] + '/access')[1]
        for time,expected in [(access['validFrom']-1,False),(access['validFrom'],True),
                              (access['validFrom'],True),(access['validTo']-1,True),(access['validTo'],False)]:
            with patch.object(self.module,'now_ms',return_value=time):
                status,result = self.scan(access['qrPayload'])
                self.assertEqual(status,200)
                self.assertEqual(result['allowed'],expected)
        admin = self.admin()
        with patch.object(self.module,'now_ms',return_value=access['validFrom']):
            self.assertEqual(self.call('/api/admin/bookings/' + booking['id'] + '/noshow',{},admin)[0],200)
            self.assertFalse(self.scan(access['qrPayload'])[1]['allowed'])
        events = self.call('/api/admin/access-events',client=admin)[1]
        self.assertNotIn(access['qrPayload'],json.dumps(events))
        self.assertNotIn(self.server.access.device_token,json.dumps(events))
        self.assertTrue(any(e['result']=='allow' for e in events['list']))

    def test_same_price_move_rotates_grant_and_price_change_is_rejected(self):
        booking,payment = self.create_payment()
        self.succeed(payment)
        old = self.call('/api/bookings/' + booking['id'] + '/access')[1]
        self.assertEqual(self.call('/api/bookings/' + booking['id'] + '/reschedule',{'date':booking['date'],'start':900,'dur':60})[0],409)
        self.assertEqual(self.call('/api/bookings/' + booking['id'] + '/reschedule',{'date':booking['date'],'start':660,'dur':60})[0],200)
        new = self.call('/api/bookings/' + booking['id'] + '/access')[1]
        self.assertNotEqual(new['qrPayload'],old['qrPayload'])
        with patch.object(self.module,'now_ms',return_value=new['validFrom']):
            self.assertFalse(self.scan(old['qrPayload'])[1]['allowed'])
            self.assertTrue(self.scan(new['qrPayload'])[1]['allowed'])
        self.call('/api/bookings/' + booking['id'] + '/cancel',{})
        with patch.object(self.module,'now_ms',return_value=new['validFrom']):
            self.assertFalse(self.scan(new['qrPayload'])[1]['allowed'])

    def test_provider_test_and_demo_never_get_real_reader_access(self):
        self.provider.mode = 'test'
        self.provider_http.test = True
        booking,payment = self.create_payment()
        self.succeed(payment)
        self.assertEqual(self.call('/api/bookings/' + booking['id'] + '/access')[1]['status'],'unavailable')
        self.server.demo_payments = True
        _,demo = self.call('/api/bookings',self.booking(720))
        _,payment = self.call('/api/bookings/' + demo['id'] + '/payments', {'method':'sbp'})
        self.assertEqual(self.call('/api/payments/' + payment['id'] + '/confirm',{})[0],200)
        self.assertNotIn('qrPayload',self.call('/api/bookings/' + demo['id'] + '/access')[1])
        self.assertFalse(self.scan('pp1_demo')[1]['allowed'])

    def test_simulator_is_admin_only_and_explicitly_marked(self):
        self.assertEqual(self.call('/api/admin/access/simulate',{'payload':'bad','doorId':'fixture'})[0],403)
        admin = self.admin()
        status,result = self.call('/api/admin/access/simulate',{'payload':'bad','doorId':'fixture'},admin)
        self.assertEqual(status,200)
        self.assertTrue(result['simulation'])
        self.assertFalse(result['allowed'])
