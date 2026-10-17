# Контракты

## Правила проекта
- «На сервере этого сайта (рекомендую)» — общие брони и новые аккаунты на сервере.
- Рабочий вариант 1-neon. Сохранять локальные пользовательские записи и исходную SQLite; demo-брони не добавлять.
- Python 3.11+, существующий server.py factory совместим; node tests/check.mjs — единая проверка. Один Python файл: python -m unittest discover -s tests -p test_identity.py (аналогично payments/access).
- Read notes.md и provider-research.md. Не записывать секреты, не отправлять реальные платежи/возвраты, SMS, команды дверям; executor не коммитит.

## Границы, решённые в спецификации
1. server.py — HTTP, session/CSRF, существующие Booking/Admin routes, интеграционная маршрутизация. Store JSON получает users, authChallenges, credentials, paymentOperations, accessGrants, accessEvents, refundOperations; defaults без удаления. Имена новых коллекций и точные внутренние методы разрешено уточнить в 01/02, но публичные контракты ниже стабильны. Сессия получает userId. Только владелец userId либо guest owner либо admin видит бронь.
2. identity.py — пароль/scrypt, регистрационные согласия, profile, WebAuthn challenge/verification, throttling. Не обращается к ЮKassa/СКУД. analytics.py — чистый аггрегатор серверных данных, деньги по событиям; не верит localStorage.
3. payments.py — HTTP adapter ЮKassa + durable service preparation/reconciliation; access.py — grant/token + standard QR SVG + decision. Они не доверяют browser success. Нет внешнего IO под SQLite write-lock. Интеграция в server.py принадлежит 02 после коммита01.
4. UI игрока: shared-account.js (новый) + существующие community.js/shared-booking.js/booking.js/cabinet.html/index.html. Один владелец 03. Cached CommunityAPI.meSync и pp:change совместимы, AccountAPI.ready. Legacy local identity не является server auth. Общие модерационные данные пока локальные и подписаны.
5. UI админа: admin.html + admin-insights.js (новый), один владелец04. Использует fetch helper либо AdminAPI новые методы, НЕ редактирует shared-booking.js параллельно03. Собственный csrf получает из BookingAPI.ready/session. Минимальная независимая обёртка admin api в admin-insights.js допустима.

## Публичные HTTP контракты
Все JSON ошибки {error:{code,message}}, mutation браузера POST+X-PP-CSRF. GET /api/session остаётся совместим и добавляет user:null|profile, capabilities:{accounts,passkeys,payments:'disabled'|'demo'|'test'|'live',access:'unconfigured'|'online'}, csrf и demoPayments.

Profile: {id,phone,phoneRaw,name,createdAt,lastLoginAt,phoneVerified:false,ageGroup,guardian,photo?,level?,tg?,showPhone?,docsOk,...совместимые profile поля}; не отдаёт passwordHash, credential public key, challenge, внутренние токены.
- POST /api/account/register {phone,password,name,ageGroup,guardian?,consents,context?} -> {user,csrf}; consents соответствует текущим canonical document IDs/version/hash, точную UI форму согласует01 в return.
- POST /api/account/login {phone,password} -> {user,csrf}; POST /api/account/logout {} -> {user:null,csrf}; GET /api/account/me -> {user}; POST /api/account/profile {допустимые поля} -> {user}; POST /api/account/password {currentPassword,newPassword} -> {ok:true,csrf?}.
- POST /api/account/passkeys/register/options {} -> options (WebAuthn JSON); /register/verify {credential} -> {ok:true}; /login/options {phone} -> options; /login/verify {credential} -> {user,csrf}; GET /api/account/passkeys -> {list:[{id,name?,createdAt}]}; POST /api/account/passkeys/delete {id} -> {ok:true}. Все challenges bound to session/purpose/account и одноразовые с TTL; JSON credential ID base64url.
- GET /api/admin/users?q=&page=1&pageSize=30 -> {list:[{id,name,phone,phoneVerified,createdAt,lastLoginAt,bookingsCount,paidCount,totalPaid}],total,page,pageSize}; GET /api/admin/users/{id} -> {user,bookings,registrations?}. Не смешивать unregistered contacts со registered users.
- GET /api/admin/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD&mode=live|test -> {from,to,timezone:'Europe/Moscow',mode,totals:{users,newUsers,bookings,payments,gross,refunds,net},series:[{date,registrations,bookings,payments,gross,refunds,net}],statuses:[{status,count}],methods:[{method,count,amount}]}; денежные числа здесь рубли, считать через копейки, предел периода366дней, zero-fill. live exclude test, test only test.
- GET /api/admin/integrations -> {payments:{mode,configured,missing:[имена переменных],message},access:{configured,mode,message,missing:[...]},passkeys:{configured,origin?,rpId?,message}}; секреты никогда. GET /api/admin/access-events?limit=50 -> {list:[{at,bookingId?,doorId,result,reason}],total}; без QR.

## Оплата/доступ — 02 уточняет внутренние details
Существующий POST /api/bookings/{id}/payments {method?} -> legacy payment дополнен {provider,confirmationUrl?,test,status}; create/retry durable. POST /api/payments/{id}/refresh {} -> {payment,booking}; GET listMyBookings/detail даёт актуальное локальное состояние без неконтролируемого фонового HTTP. POST /api/yookassa/webhook {type,event,object:{id}} -> {ok:true}; authentic provider GET перед применением, без client CSRF; unknown object не меняет данных.
GET /api/bookings/{id}/access -> {status:'unavailable'|'scheduled'|'active'|'expired'|'revoked',reason,validFrom?,validTo?,qrPayload?,qrSvg?,test:false}; только владелец/admin; QR payload никогда в обычном booking_view, листингах или аналитике. Активный/будущий реальный оплаченный grant может показать QR, но решение только в интервале.
POST /api/access/verify Authorization:Bearer PP_SKUD_DEVICE_TOKEN {payload,doorId,requestId?} -> {allowed:boolean,reason,bookingId?,validUntil?}; никакого прямого unlock route. Неподключённое устройство/неверный bearer ->403, ошибки fail closed. Отдельный admin simulator endpoint допустим, всегда явно simulation и не разрешает реальный физический вход. Результаты без payload пишутся в audit.
Конфигурация и публичные capabilities не утверждают совместимость с пока неизвестным оборудованием.

## Приземлённые интерфейсы
Будут дополнены контрактами исполнителей после коммитов.
