"""Online authorization only. No controller commands or offline unlock promises."""
import hashlib
import hmac
import io
import os
import re
import secrets

import qrcode
import qrcode.image.svg


class Access:
    def __init__(self):
        self.device_token = os.environ.get('PP_SKUD_DEVICE_TOKEN', '')
        self.door_id = os.environ.get('PP_SKUD_DOOR_ID', '')

    def readiness(self):
        missing = [name for name, value in [('PP_SKUD_DEVICE_TOKEN', re.fullmatch(r'[A-Za-z0-9_-]{32,256}', self.device_token)),
                                           ('PP_SKUD_DOOR_ID', 1 <= len(self.door_id) <= 100)] if not value]
        return dict(configured=not missing, mode='online' if not missing else 'unconfigured', missing=missing,
                    message='Online-коннектор настроен; совместимость оборудования требует полевой проверки' if not missing
                    else 'СКУД не подключена. Ожидаются модель оборудования и настройка коннектора')

    def authorized(self, header, door):
        expected = 'Bearer ' + self.device_token
        return bool(self.readiness()['configured'] and door == self.door_id and
                    hmac.compare_digest(str(header), expected))

    @staticmethod
    def revoke(db, booking_id):
        for grant in db['accessGrants']:
            if grant['bookingId'] == booking_id:
                grant['revoked'] = True

    @classmethod
    def issue(cls, db, booking, at_ms):
        cls.revoke(db, booking['id'])
        payment = next((p for p in db['payments'] if p['id'] == booking.get('paymentId')), {})
        if booking['status'] != 'paid' or payment.get('test', True) or payment.get('status') != 'succeeded':
            return
        token = 'pp1_' + secrets.token_urlsafe(32)
        start = at_ms(booking['date'], booking['start'])
        db['accessGrants'].append(dict(id='grant_' + secrets.token_urlsafe(18), bookingId=booking['id'],
            paymentId=payment['id'], token=token, digest=hashlib.sha256(token.encode()).hexdigest(),
            validFrom=start, validTo=start + booking['dur'] * 60000, revoked=False))

    @staticmethod
    def decision(db, grant, now, at_ms):
        if not grant or grant.get('revoked'):
            return 'revoked'
        booking = next((b for b in db['bookings'] if b['id'] == grant['bookingId']), None)
        payment = next((p for p in db['payments'] if p['id'] == grant['paymentId']), {})
        if not booking or booking['status'] != 'paid' or booking.get('paymentId') != grant['paymentId']:
            return 'revoked'
        if payment.get('test', True) or payment.get('status') != 'succeeded' or payment.get('refunded', 0):
            return 'payment_invalid'
        if any(r['paymentId'] == payment['id'] and r['status'] != 'canceled' for r in db['refundOperations']):
            return 'refund_pending'
        start = at_ms(booking['date'], booking['start'])
        if start != grant['validFrom'] or start + booking['dur'] * 60000 != grant['validTo']:
            return 'revoked'
        if now < grant['validFrom']:
            return 'scheduled'
        return 'expired' if now >= grant['validTo'] else 'active'

    @classmethod
    def view(cls, db, booking, now, at_ms):
        grants = [g for g in db['accessGrants'] if g['bookingId'] == booking['id']]
        if not grants:
            return dict(status='unavailable', reason='Пропуск доступен после подтверждённой реальной оплаты', test=False)
        grant = grants[-1]
        reason = cls.decision(db, grant, now, at_ms)
        result = dict(status=reason if reason in {'active', 'scheduled', 'expired'} else 'revoked',
                      reason=reason, validFrom=grant['validFrom'], validTo=grant['validTo'], test=False)
        if reason in {'active', 'scheduled'}:
            qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=4, box_size=10)
            qr.add_data(grant['token'])
            qr.make(fit=True)
            output = io.BytesIO()
            qr.make_image(image_factory=qrcode.image.svg.SvgPathImage).save(output)
            result.update(qrPayload=grant['token'], qrSvg=output.getvalue().decode())
        return result

    @classmethod
    def verify(cls, db, payload, door, now, at_ms, simulation=False):
        digest = hashlib.sha256(payload.encode()).hexdigest()
        grant = next((g for g in db['accessGrants'] if hmac.compare_digest(g['digest'], digest)), None)
        reason = cls.decision(db, grant, now, at_ms)
        result = dict(allowed=reason == 'active', reason=reason)
        if grant:
            result.update(bookingId=grant['bookingId'], validUntil=grant['validTo'])
        event = dict(at=now, doorId=door, result='allow' if result['allowed'] else 'deny', reason=reason)
        if grant:
            event['bookingId'] = grant['bookingId']
        if simulation:
            result['simulation'] = True
            event['reason'] = 'simulation:' + reason
        db['accessEvents'].append(event)
        return result
