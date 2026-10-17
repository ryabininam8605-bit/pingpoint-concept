"""Durable YooKassa redirect operations. Provider I/O never runs in a DB transaction."""
import base64
import copy
from datetime import datetime
from decimal import Decimal, InvalidOperation
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.request


class PaymentError(Exception):
    def __init__(self, code, message, status=400):
        self.code, self.message, self.status = code, message, status


def cents(value):
    try:
        amount = Decimal(str(value)) * 100
        if not amount.is_finite() or amount < 0 or amount != amount.to_integral_value():
            raise ValueError()
        return int(amount)
    except (ValueError, InvalidOperation):
        raise PaymentError('AMOUNT', 'Некорректная сумма') from None


def money(value):
    return f'{cents(value) / 100:.2f}'


def timestamp(value, fallback):
    try:
        return int(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000)
    except (ValueError, AttributeError):
        return fallback


class YooKassa:
    base_url = 'https://api.yookassa.ru/v3'

    def __init__(self):
        self.shop_id = os.environ.get('PP_YOOKASSA_SHOP_ID', '')
        self.secret = os.environ.get('PP_YOOKASSA_SECRET_KEY', '')
        self.mode = os.environ.get('PP_YOOKASSA_MODE', '')
        self.origin = os.environ.get('PP_PUBLIC_ORIGIN', '').rstrip('/')
        self.receipt_mode = os.environ.get('PP_RECEIPT_MODE', '')

    def readiness(self):
        values = dict(PP_YOOKASSA_SHOP_ID=self.shop_id, PP_YOOKASSA_SECRET_KEY=self.secret,
                      PP_YOOKASSA_MODE=self.mode if self.mode in {'test', 'live'} else '',
                      PP_PUBLIC_ORIGIN=self.origin if self.origin.startswith('https://') else '',
                      PP_RECEIPT_MODE=self.receipt_mode if self.receipt_mode in {'external', 'provider'} else '')
        if self.receipt_mode == 'external':
            values['PP_RECEIPT_EXTERNAL_CONFIRMED'] = os.environ.get('PP_RECEIPT_EXTERNAL_CONFIRMED') == 'true'
        elif self.receipt_mode == 'provider':
            for name, allowed in [('PP_RECEIPT_TAX_SYSTEM_CODE', range(1, 7)), ('PP_RECEIPT_VAT_CODE', range(1, 13))]:
                value = os.environ.get(name, '')
                values[name] = value.isdigit() and int(value) in allowed
            for name in ['PP_RECEIPT_PAYMENT_MODE', 'PP_RECEIPT_PAYMENT_SUBJECT']:
                values[name] = bool(os.environ.get(name))
        missing = [name for name, value in values.items() if not value]
        return dict(mode=self.mode if not missing else 'disabled', configured=not missing, missing=missing,
                    message='ЮKassa: ' + self.mode + '; проверьте магазин, уведомления и фискализацию' if not missing
                    else 'ЮKassa не подключена. Требуются магазин, HTTPS и схема фискализации')

    def request(self, method, path, data=None, key=None):
        headers = {'Content-Type': 'application/json', 'Authorization': 'Basic ' +
                   base64.b64encode((self.shop_id + ':' + self.secret).encode()).decode()}
        if key:
            headers['Idempotence-Key'] = key
        request = urllib.request.Request(self.base_url + path, headers=headers, method=method,
                                         data=json.dumps(data).encode() if data is not None else None)
        try:
            with urllib.request.urlopen(request, timeout=12) as response:
                result = json.loads(response.read(1048576))
                if not isinstance(result, dict):
                    raise ValueError()
                return result
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            # Provider body may include personal data or credentials. Never forward it.
            raise PaymentError('PROVIDER_PENDING', 'Ответ ЮKassa не получен. Повторите сверку; новая оплата не создаётся.', 503) from None

    def receipt(self, booking, amount):
        if self.receipt_mode != 'provider':
            return None
        return dict(customer=dict(phone='+' + booking['phone']),
                    tax_system_code=int(os.environ['PP_RECEIPT_TAX_SYSTEM_CODE']),
                    items=[dict(description='Аренда комнаты настольного тенниса', quantity='1.00',
                                amount=dict(value=money(amount), currency='RUB'),
                                vat_code=int(os.environ['PP_RECEIPT_VAT_CODE']),
                                payment_mode=os.environ['PP_RECEIPT_PAYMENT_MODE'],
                                payment_subject=os.environ['PP_RECEIPT_PAYMENT_SUBJECT'])])


class Payments:
    def __init__(self, server, at_ms, record, check_range, consume_promo, booking_view, private_booking, access):
        self.server, self.store = server, server.store
        self.provider = YooKassa()
        self.at_ms, self.record, self.check_range = at_ms, record, check_range
        self.consume_promo, self.booking_view, self.private_booking, self.access = consume_promo, booking_view, private_booking, access

    @staticmethod
    def now():
        return int(time.time() * 1000)

    def require(self):
        if not self.provider.readiness()['configured']:
            raise PaymentError('PAYMENT_DISABLED', 'ЮKassa ещё не подключена: требуется настройка магазина, HTTPS и фискализации.', 503)

    def provider_context(self):
        # Shop identity is not a secret. Never persist the API key: rotating a key
        # for the same shop is safe; reusing an unknown operation in another shop is not.
        return dict(shopId=getattr(self.provider, 'shop_id', ''), mode=self.provider.mode,
                    endpoint=getattr(self.provider, 'base_url', ''))

    def check_context(self, operation):
        if operation.get('providerContext') != self.provider_context():
            # Legacy unbound operations also fail closed instead of being silently
            # assigned to whatever merchant happens to be configured now.
            raise PaymentError('PAYMENT_CONFIG_CHANGED', 'Магазин или режим ЮKassa изменился. Восстановите исходную конфигурацию и выполните сверку; повтор операции заблокирован.', 409)

    @staticmethod
    def public(payment):
        # No durable operation parameters, credentials or access tokens here.
        fields = ['id', 'bookingId', 'amount', 'method', 'status', 'createdAt', 'paidAt', 'refunded',
                  'refundedAt', 'test', 'provider', 'providerId', 'confirmationUrl', 'reviewReason']
        return {k: payment[k] for k in fields if k in payment}

    def start(self, booking_id, session):
        self.require()
        def prepare(db):
            booking = self.private_booking(db, booking_id, session)
            previous = next((op for op in reversed(db['paymentOperations']) if op['bookingId'] == booking_id and
                             op['status'] not in {'canceled', 'failed'}), None)
            if previous:
                return copy.deepcopy(previous)
            if booking['status'] != 'pending':
                raise PaymentError('STATE', 'Бронь не ожидает оплаты')
            if cents(booking['amount']) <= 0:
                raise PaymentError('AMOUNT', 'Для оплаты требуется положительная сумма')
            ident = 'pay_' + secrets.token_urlsafe(18)
            params = dict(amount=dict(value=money(booking['amount']), currency='RUB'), capture=True,
                          confirmation=dict(type='redirect', return_url=self.provider.origin + '/1-neon/cabinet.html'),
                          description='Бронь ' + booking['number'], metadata=dict(bookingId=booking_id, paymentId=ident))
            receipt = self.provider.receipt(booking, booking['amount'])
            if receipt:
                params['receipt'] = receipt
            op = dict(id='op_' + secrets.token_urlsafe(18), bookingId=booking_id, paymentId=ident,
                      key=secrets.token_urlsafe(32), params=params, createdAt=self.now(), status='prepared',
                      providerContext=self.provider_context())
            payment = dict(id=ident, bookingId=booking_id, amount=booking['amount'], method='card',
                           status='pending', createdAt=self.now(), paidAt=None, test=self.provider.mode == 'test', provider='yookassa')
            db['payments'].append(payment)
            db['paymentOperations'].append(op)
            booking['paymentId'] = ident
            booking['test'] = payment['test']
            return copy.deepcopy(op)
        op = self.store.transaction(prepare)
        return self.run_payment(op)

    def run_payment(self, op):
        self.require()
        self.check_context(op)
        if op.get('providerId'):
            obj = self.provider.request('GET', '/payments/' + op['providerId'])
        else:
            if self.now() - op['createdAt'] >= 24 * 3600000:
                self.store.transaction(lambda db: self.mark_review(db, op['paymentId'], 'idempotency_expired'))
                raise PaymentError('PAYMENT_REVIEW', 'Исход оплаты неизвестен более 24 часов. Нужна сверка администратора; повторное списание заблокировано.', 409)
            obj = self.provider.request('POST', '/payments', op['params'], op['key'])
        return self.store.transaction(lambda db: self.apply_payment(db, op['paymentId'], obj))

    def mark_review(self, db, payment_id, reason):
        payment = next(p for p in db['payments'] if p['id'] == payment_id)
        payment['reviewReason'] = reason

    def validate_payment(self, op, payment, obj):
        valid_id = isinstance(obj.get('id'), str) and 1 <= len(obj['id']) <= 100 and all(c.isalnum() or c in '-_' for c in obj['id'])
        if not valid_id or (op.get('providerId') and obj['id'] != op['providerId']) or \
                obj.get('metadata') != op['params']['metadata'] or obj.get('amount', {}).get('currency') != 'RUB' or \
                cents(obj.get('amount', {}).get('value', -1)) != cents(payment['amount']) or \
                type(obj.get('test')) is not bool or obj['test'] != payment['test'] or \
                obj.get('status') not in {'pending', 'waiting_for_capture', 'succeeded', 'canceled'} or \
                (obj['status'] == 'succeeded' and obj.get('paid') is not True):
            raise PaymentError('PROVIDER_MISMATCH', 'Данные ЮKassa не совпадают с оплатой. Нужна сверка администратора.', 409)

    def apply_payment(self, db, payment_id, obj):
        payment = next(p for p in db['payments'] if p['id'] == payment_id)
        op = next(o for o in db['paymentOperations'] if o['paymentId'] == payment_id)
        self.check_context(op)
        booking = next(b for b in db['bookings'] if b['id'] == payment['bookingId'])
        self.validate_payment(op, payment, obj)
        op['providerId'] = obj['id']
        payment['providerId'] = obj['id']
        # A delayed older notification cannot roll back a captured/refunded payment.
        if payment.get('paidAt'):
            return self.public(payment)
        confirmation = obj.get('confirmation', {}).get('confirmation_url')
        if isinstance(confirmation, str) and confirmation.startswith('https://'):
            payment['confirmationUrl'] = confirmation
        if obj['status'] == 'succeeded':
            payment.update(status='succeeded', paidAt=timestamp(obj.get('captured_at'), self.now()),
                           method=str(obj.get('payment_method', {}).get('type', 'card'))[:40])
            op['status'] = 'succeeded'
            ready = booking['status'] in {'pending', 'expired'} and booking.get('paymentId') == payment_id
            try:
                if not ready or self.at_ms(booking['date'], booking['start']) <= self.now():
                    raise ValueError()
                self.check_range(db, booking['date'], booking['start'], booking['dur'], booking['id'], True)
                self.consume_promo(db, booking)
            except Exception:
                payment.update(status='requires_review', reviewReason='booking_unavailable')
                if booking['status'] in {'pending', 'expired'}:
                    self.record(booking, 'payment_review', 'yookassa', 'Оплата получена, время недоступно; нужен возврат или решение администратора')
                self.access.revoke(db, booking['id'])
            else:
                booking.update(expiresAt=None, code=None, test=payment['test'])
                self.record(booking, 'paid', 'yookassa', 'Оплата подтверждена ЮKassa')
                self.access.issue(db, booking, self.at_ms)
        elif obj['status'] == 'canceled':
            op['status'] = 'canceled'
            payment['status'] = 'canceled'
        else:
            op['status'] = 'pending'
            payment['status'] = 'pending'
        return self.public(payment)

    def refresh(self, payment_id, session):
        def locate(db):
            payment = next((p for p in db['payments'] if p['id'] == payment_id and p.get('provider') == 'yookassa'), None)
            if not payment:
                raise PaymentError('NOTFOUND', 'Платёж не найден', 404)
            self.private_booking(db, payment['bookingId'], session)
            return copy.deepcopy(next(o for o in db['paymentOperations'] if o['paymentId'] == payment_id))
        payment = self.run_payment(self.store.transaction(locate))
        # Pending refund outcomes are reconciled on the same deliberate refresh.
        refunds = self.store.transaction(lambda db: copy.deepcopy([r for r in db['refundOperations']
            if r['paymentId'] == payment_id and r['status'] not in {'succeeded', 'canceled'}]))
        for refund in refunds:
            self.run_refund(refund)
        return self.store.transaction(lambda db: dict(payment=self.public(next(p for p in db['payments'] if p['id'] == payment_id)),
            booking=self.booking_view(db, self.private_booking(db, payment['bookingId'], session))))

    def webhook(self, body):
        event = body.get('event')
        if not isinstance(body.get('object'), dict):
            raise PaymentError('VALID', 'Некорректное уведомление')
        object_id = body['object'].get('id')
        if event not in {'payment.succeeded', 'payment.canceled', 'refund.succeeded'} or not isinstance(object_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', object_id):
            raise PaymentError('VALID', 'Некорректное уведомление')
        if event == 'refund.succeeded':
            op = self.store.transaction(lambda db: copy.deepcopy(next((r for r in db['refundOperations'] if r.get('providerId') == object_id), None)))
            if op:
                self.run_refund(op)
        else:
            op = self.store.transaction(lambda db: copy.deepcopy(next((o for o in db['paymentOperations'] if o.get('providerId') == object_id), None)))
            if op:
                self.run_payment(op)
            elif self.provider.readiness()['configured']:
                prepared = self.store.transaction(lambda db: copy.deepcopy([o for o in db['paymentOperations']
                    if not o.get('providerId') and o['status'] == 'prepared']))
                if not prepared:
                    return dict(ok=True)
                # Until metadata is fetched the notifying operation is unknown.
                # Conservatively refuse recovery if any candidate belongs to a
                # different shop; no GET or retry is sent with changed credentials.
                for candidate in prepared:
                    self.check_context(candidate)
                # A capture notification can beat the create response, or recover a
                # connection drop. Only merchant-authenticated GET metadata may bind it.
                obj = self.provider.request('GET', '/payments/' + object_id)
                payment_id = obj.get('metadata', {}).get('paymentId')
                def recover(db):
                    candidate = next((o for o in db['paymentOperations'] if o['paymentId'] == payment_id), None)
                    if candidate:
                        self.apply_payment(db, payment_id, obj)
                self.store.transaction(recover)
        return dict(ok=True)

    def refund(self, booking_id, session, action, body):
        self.require()
        def prepare(db):
            booking = self.private_booking(db, booking_id, session)
            payment = next((p for p in db['payments'] if p['id'] == booking.get('paymentId') and p.get('provider') == 'yookassa'), None)
            if not payment or not payment.get('paidAt'):
                raise PaymentError('STATE', 'Нет подтверждённой оплаты для возврата')
            source = next((o for o in db['paymentOperations'] if o['paymentId'] == payment['id']), {})
            self.check_context(source)
            existing = [r for r in db['refundOperations'] if r['paymentId'] == payment['id']]
            pending = next((r for r in existing if r['status'] not in {'succeeded', 'canceled'}), None)
            if pending:
                return copy.deepcopy(pending)
            left = self.at_ms(booking['date'], booking['start']) - self.now()
            if action == 'cancel' and not session['admin'] and left <= 0:
                raise PaymentError('STARTED', 'Игра уже началась — отмена недоступна')
            if action == 'cancel' and ((session['admin'] and not body.get('withRefund', False)) or
                (not session['admin'] and left < db['settings']['cancelHours'] * 3600000)):
                if booking['status'] != 'paid':
                    raise PaymentError('STATE', 'Эту бронь отменить нельзя')
                self.access.revoke(db, booking_id)
                self.record(booking, 'cancelled' if session['admin'] else 'refund_partial', 'client' if not session['admin'] else 'admin')
                booking['refundAmount'] = None
                return None
            remaining = cents(payment['amount']) - sum(cents(r['amount']) for r in existing if r['status'] == 'succeeded')
            requested = cents(body.get('amount')) if action == 'partial-refund' else remaining
            if requested <= 0 or requested > remaining:
                raise PaymentError('AMOUNT', 'Сумма возврата недоступна')
            if action == 'partial-refund' and booking['status'] != 'refund_partial':
                raise PaymentError('STATE', 'Бронь не ожидает частичного возврата')
            amount = requested / 100
            params = dict(payment_id=payment['providerId'], amount=dict(value=money(amount), currency='RUB'))
            receipt = self.provider.receipt(booking, amount)
            if receipt:
                params['receipt'] = receipt
            op = dict(id='refund_' + secrets.token_urlsafe(18), paymentId=payment['id'], bookingId=booking_id,
                      amount=amount, status='pending', createdAt=self.now(), key=secrets.token_urlsafe(32), params=params,
                      providerContext=copy.deepcopy(source['providerContext']))
            db['refundOperations'].append(op)
            self.access.revoke(db, booking_id)
            self.record(booking, 'refund_pending', 'admin' if session['admin'] else 'client', 'Возврат запрошен; результат ожидается от ЮKassa')
            return copy.deepcopy(op)
        op = self.store.transaction(prepare)
        if op:
            self.run_refund(op)
        return self.store.transaction(lambda db: self.booking_view(db, self.private_booking(db, booking_id, session)))

    def run_refund(self, op):
        self.require()
        self.check_context(op)
        if op.get('providerId'):
            obj = self.provider.request('GET', '/refunds/' + op['providerId'])
        else:
            if self.now() - op['createdAt'] >= 24 * 3600000:
                raise PaymentError('REFUND_REVIEW', 'Неизвестный исход возврата: требуется сверка администратора', 409)
            obj = self.provider.request('POST', '/refunds', op['params'], op['key'])
        return self.store.transaction(lambda db: self.apply_refund(db, op['id'], obj))

    def apply_refund(self, db, ident, obj):
        op = next(r for r in db['refundOperations'] if r['id'] == ident)
        self.check_context(op)
        if not isinstance(obj.get('id'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', obj['id']) or (op.get('providerId') and obj['id'] != op['providerId']) or \
                obj.get('payment_id') != op['params']['payment_id'] or obj.get('amount', {}).get('currency') != 'RUB' or \
                cents(obj.get('amount', {}).get('value', -1)) != cents(op['amount']) or \
                obj.get('status') not in {'pending', 'succeeded', 'canceled'}:
            raise PaymentError('PROVIDER_MISMATCH', 'Данные возврата ЮKassa не совпадают', 409)
        op['providerId'] = obj['id']
        if op['status'] == 'succeeded':
            return
        op['status'] = obj['status']
        if obj['status'] == 'succeeded':
            # created_at dates the refund request, which may stay pending for days.
            # YooKassa supplies no distinct success timestamp here: record the first
            # merchant-verified succeeded transition and never move it on duplicates.
            op['succeededAt'] = self.now()
            payment = next(p for p in db['payments'] if p['id'] == op['paymentId'])
            booking = next(b for b in db['bookings'] if b['id'] == op['bookingId'])
            total = sum(cents(r['amount']) for r in db['refundOperations'] if r['paymentId'] == payment['id'] and r['status'] == 'succeeded')
            payment.update(refunded=total / 100, refundedAt=op['succeededAt'],
                           status='refunded' if total == cents(payment['amount']) else 'partially_refunded')
            booking['refundAmount'] = total / 100
            self.record(booking, 'refunded' if total == cents(payment['amount']) else 'refund_partial', 'yookassa', 'Возврат подтверждён ЮKassa')
            self.access.revoke(db, booking['id'])
