# Проверенные внешние контракты — 2026-10-17

Только официальная документация. Это технические факты, не ответы пользователя.

## ЮKassa
- API v3: https://api.yookassa.ru/v3 . Basic Auth shopId/secretKey только на сервере.
- Создание платежа: POST /payments, amount.value десятичная строка и currency=RUB, capture=true для одностадийного платежа, confirmation.type=redirect и return_url; metadata для связи с внутренней бронью. Состояние pending не даёт право входа. https://yookassa.ru/developers/payment-acceptance/getting-started/payment-process
- POST требует Idempotence-Key длиной до 64 символов, повтор с теми же параметрами и ключом предотвращает повтор операции в пределах 24 часов. Следовательно, после неопределённого исхода нельзя бездумно создавать новый ключ; хранить попытку и сверять состояние. https://yookassa.ru/developers/using-api/interaction-format
- События payment.succeeded, payment.canceled, refund.succeeded. При Basic Auth URL уведомлений настраивается в кабинете магазина. URL HTTPS, порт 443 или 8443. Уведомления повторяются до 24 часов при отсутствии HTTP 200. Для подлинности допускается проверка состояния объекта через API; тело уведомления само по себе не доказательство. https://yookassa.ru/developers/using-api/webhooks
- Тестовый магазин имеет отдельные учётные данные; API отдаёт test=true. Тестовый платёж нельзя смешивать с реальной выручкой или доступом в физическую комнату. https://yookassa.ru/developers/payment-acceptance/testing-and-going-live/testing
- Формат налоговых чеков и режим магазина зависят от настроек продавца; нельзя выдумывать НДС или систему налогообложения. Подключение реальных платежей требует известной схемы фискализации.
- Документы чеков: https://yookassa.ru/developers/payment-acceptance/receipts/54fz/yoomoney/payments . Конфигурация должна явно выбрать передачу receipt с параметрами продавца либо подтверждённую внешнюю фискализацию; отсутствие сведений не разрешает молча отправлять live платежи без выбранной схемы.
- Возвраты: https://yookassa.ru/developers/payment-acceptance/after-the-payment/refunds . POST /refunds c payment_id и amount, GET /refunds/{id} для сверки. Идемпотентность и событие refund.succeeded применимы отдельно от платежа. Pending не означает, что деньги уже возвращены.

## WebAuthn и QR
- Официальная библиотека Duo py_webauthn: https://duo-labs.github.io/py_webauthn/registration.html и https://duo-labs.github.io/py_webauthn/authentication.html . Регистрация ключа только для установленного аккаунта; проверять expected_challenge, expected_rp_id, expected_origin, require_user_verification=True; сохранять credential_public_key/sign_count/transports и обновлять sign_count после входа.
- https://pypi.org/project/webauthn/ — проверенная версия 3.0.1; docs примеры старше, точные сигнатуры проверить по установленному пакету. Fingerprint/face/PIN — выбор authenticator устройства, сайт получает public-key assertion, не биометрию.
- https://pypi.org/project/qrcode/ — 8.2, SVG factory SvgPathImage. В текущем окружении qrcode 8.2 уже установлен; cv2 и PIL доступны для независимого decode PNG/матрицы. Сам SVG нужно растеризовать фактический вывод, а не подтверждать произвольный QR, повторно созданный тестом.

## СКУД
Производитель, модель контроллера, QR-считыватель, протокол и доступность сети пока не сообщены. Совместимость с конкретным оборудованием утверждать нельзя. Обсуждаемый безопасный шов: аутентифицированный запрос устройства к серверу с непрозрачным QR-токеном и проверка оплаченного состояния, отмены и интервала по серверному времени. Это вариант архитектуры, не выбранный протокол СКУД.

## Открытые решения брифинга
Пользователь отложил сведения об оборудовании и ЮKassa/домене; выбрал пароль или отпечаток и повторный вход до конца сеанса. Реальные деньги/дверь не подключать до сведений и проверки подключения. Парольный вход и WebAuthn готовятся сейчас.
