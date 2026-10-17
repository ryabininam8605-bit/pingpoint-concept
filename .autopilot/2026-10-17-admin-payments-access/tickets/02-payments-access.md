# 02 — ЮKassa и пропуск на время брони

**Требования:** R05, R06, R07, R08, R09, R10, R11, G02
**Зависит от:** 01
**Зона:** `server.py` · `payments.py` · `access.py` · `tests/test_payments.py` · `tests/test_access.py` · `README.md`
**Волна:** 2
**Ревью:** да — платежи и физический доступ
**Модель:** сильная

## Что должно заработать
Серверная интеграция API ЮKassa с durable попытками, сверкой, возвратами и безопасным late success; настоящее QR-кодирование пропуска, online reader authorization и журнал. Реальный магазин/домен/фискализация и конкретная СКУД неизвестны: интерфейс честно показывает неактивную интеграцию, README перечисляет нужные данные. Никаких реальных оплат или открытия двери в разработке.

## Из брифа, дословно
> «к сайту должна быть подключена юкасса», «статисктку по выручке и оплате», «так же есть досту пскуд», «должны получть qr код», «комната должан допускатьт в назначенный период»
> «уточню отвечу позже, как даст ответ клиент», «сайт есть. скажу позже»
> «повторно в течениии сеанса можно проходить, как срок заканчивается qr не действительный»

## Разделы спецификации
Истории R05–R11/G02, Решения, Открытые места; interfaces целиком и приземлённые01. Документация provider-research.md.

## Критерии приёмки
- [ ] Server-to-provider redirect payments по серверной сумме RUB, стабильные idempotency key+params, HTTP вне write-lock, повтор/timeout/restart не создаёт двойное списание; key старше24ч не повторяется как новая операция без выяснения.
- [ ] Webhook и refresh сверяют merchant payment API object/id/metadata/amount/currency/paid/test, fake body/redirect не подтверждает; дубли/перестановка/unknown не добавляют деньги. При поздней оплате конфликт не выдаёт пропуск и виден администратору.
- [ ] Возвраты реальные через адаптер с отдельным durable operation/status и event time, без фантазий о завершении. Cancel/move revoke grant; same-price move работает, price-changing реальный move отклоняется явно без fake settlement.
- [ ] Live/test/demo раздельны, test/demo не допускает реальный reader; интеграция disabled без конфигурации/фискальной схемы. Новые empty env names в .env.example. Сайт не принимает PAN/CVV в live mode.
- [ ] Единый QR payload >=128bits, real standard SVG with quiet zone; выдается только owner/admin отдельно от обычных booking lists. Независимый decoder восстанавливает payload в QA (dev decoder установка разрешена, записать команду/результат).
- [ ] Reader Bearer+door binding, online decision [start,end), повторные входы разрешены; exact-end/before-start/cancel/refund/move/noshow/test/invalid/unauthorized/error запрещены; старый grant не оживает. Секреты и payload в audit/обычных логах отсутствуют.
- [ ] Admin integration readiness и redacted access events доступны; simulator явно simulation. Не заявлять совместимость с неизвестной моделью СКУД и не отправлять unlock команды.
- [ ] Mock provider HTTP + независимые guest/account sessions через публичные routes, retries/races/restart/auth/time/QR покрыты, full check green. README содержит configure/run/test/границы и фискализацию без выдуманных параметров.
