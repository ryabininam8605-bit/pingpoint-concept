"""Cash received before fees, by Moscow event date; all arithmetic in kopecks."""
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

MOSCOW = timezone(timedelta(hours=3))


class AnalyticsError(Exception):
    pass


def kopecks(value):
    try:
        amount = Decimal(str(value))
        if not amount.is_finite() or amount < 0:
            raise ValueError()
        return int((amount * 100).quantize(Decimal('1'), rounding=ROUND_HALF_UP))
    except (InvalidOperation, ValueError, TypeError):
        raise AnalyticsError('Некорректная сумма события') from None


def event_date(value):
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    try:
        return datetime.fromtimestamp(value / 1000, MOSCOW).date().isoformat()
    except (ValueError, OSError, OverflowError):
        return None


def period(query):
    today = datetime.now(MOSCOW).date()
    try:
        start = date.fromisoformat(query.get('from', (today - timedelta(days=29)).isoformat()))
        end = date.fromisoformat(query.get('to', today.isoformat()))
        if start > end or (end-start).days >= 366:
            raise ValueError()
        mode = query.get('mode', 'live')
        if mode not in {'live', 'test'}:
            raise ValueError()
        return start, end, mode
    except (TypeError, ValueError):
        raise AnalyticsError('Выберите корректный период до 366 дней и режим live или test') from None


def summarize(db, query):
    start, end, mode = period(query)
    series = {}
    for offset in range((end-start).days + 1):
        ds = (start + timedelta(days=offset)).isoformat()
        series[ds] = dict(date=ds, registrations=0, bookings=0, payments=0, gross=0, refunds=0, net=0)
    for user in db.get('users', []):
        ds = event_date(user.get('createdAt'))
        if ds in series:
            series[ds]['registrations'] += 1
    for booking in db.get('bookings', []):
        if bool(booking.get('test', False)) != (mode == 'test'):
            continue
        ds = event_date(booking.get('createdAt'))
        if ds in series:
            series[ds]['bookings'] += 1
    payments = [p for p in db.get('payments', []) if bool(p.get('test', True)) == (mode == 'test')]
    statuses = Counter()
    methods = {}
    for payment in payments:
        if event_date(payment.get('createdAt')) in series:
            statuses[str(payment.get('status', 'unknown'))] += 1
        ds = event_date(payment.get('paidAt'))
        if ds in series and payment.get('status') in {'succeeded', 'refunded', 'partially_refunded', 'requires_review'}:
            cents = kopecks(payment['amount'])
            series[ds]['gross'] += cents
            series[ds]['payments'] += 1
            method = str(payment.get('method') or 'unknown')
            bucket = methods.setdefault(method, dict(method=method, count=0, amount=0))
            bucket['count'] += 1
            bucket['amount'] += cents
        # Durable confirmed refund operations preserve separate dates of partial refunds.
        events = [r for r in db.get('refundOperations', []) if r.get('paymentId') == payment['id'] and r.get('status') == 'succeeded']
        if events:
            for refund in events:
                ds = event_date(refund.get('succeededAt'))
                if ds in series:
                    series[ds]['refunds'] += kopecks(refund['amount'])
        elif payment.get('refunded', 0) and payment.get('refundedAt'):
            # Legacy demo ledger contains only the latest aggregate refund timestamp.
            ds = event_date(payment['refundedAt'])
            if ds in series:
                series[ds]['refunds'] += kopecks(payment['refunded'])
    totals = dict(users=len(db.get('users', [])), newUsers=0, bookings=0, payments=0, gross=0, refunds=0, net=0)
    for point in series.values():
        point['net'] = point['gross'] - point['refunds']
        totals['newUsers'] += point['registrations']
        for field in ['bookings', 'payments', 'gross', 'refunds', 'net']:
            totals[field] += point[field]
        for field in ['gross', 'refunds', 'net']:
            point[field] = point[field] / 100
    for field in ['gross', 'refunds', 'net']:
        totals[field] = totals[field] / 100
    for bucket in methods.values():
        bucket['amount'] = bucket['amount'] / 100
    return dict(from_=start.isoformat(), to=end.isoformat(), timezone='Europe/Moscow', mode=mode,
                totals=totals, series=list(series.values()), statuses=[dict(status=k, count=v) for k, v in sorted(statuses.items())],
                methods=sorted(methods.values(), key=lambda row: row['method']))
