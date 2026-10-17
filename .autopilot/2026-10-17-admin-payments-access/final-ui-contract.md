# F1 — итоговые исправления UI

- `BookingAPI.request` синхронизирует session snapshot после успешного `{user}` текущего аккаунта из session/me/profile/register/login/logout/passkey-login-verify, даже без `csrf`. Просмотр чужого пользователя в admin API и WebAuthn registration options с user-descriptor не изменяют текущий аккаунт. Последующая смена пароля с ответом только `{ok,csrf}` сохраняет свежий профиль; события `pp:session` и CommunityAPI согласованы.
- Контакты гостя больше не обещают SMS с кодом/чеком. QR появляется в брони текущего браузера после подтверждения оплаты; доступ с других устройств объяснён через регистрацию и вход.
- `PPUI.sheet({initialFocus:'close',...})` — ограниченная политика начального фокуса на закрытии. Общий `BookingAPI.mountAccess(container,id)` выбирает её только в своём родительском `.pp-sheet` через `data-pp-initial-focus="close"`, один раз возвращает body.scrollTop=0 и фокусирует закрытие с preventScroll. Последующий polling прокрутку не трогает. Обычные формы сохраняют первый input, замыкание Tab внутри модального окна остаётся. Checkout step5 больше не фокусирует календарь ниже QR.
- На html/body и sidebar админки скрыты native scrollbar rails; overflow sidebar остаётся auto, скролл не отключён.
- Версии изменённых community/shared-booking/booking assets в index/cabinet/admin обновлены до `20261017b`; остальные page changes отсутствуют.

## Регрессии
Целевые account/player/admin tests: 23/23 (до F1 17). Новые meaningful cases: read/edit профиля → смена пароля с CSRF-only; admin read другого user; реальный step3 с гостевыми инструкциями; реальные sheet + access mount + cabinet showCode→showBooking и checkout step5; Tab wrapping и обычный auth initial focus; CSS scroll rail contract.

Окончательный `node tests/check.mjs` после всех правок: syntax10, Node36, Python38 — 74 теста зелёные (до F1 68). `git diff --check` — без whitespace errors.

RED до исправлений: snapshot `Before` вместо `Updated`; гостевой step3 обещал код/чек на телефон; QR modal фокусировал календарь и прокручивался; html не имел scrollbar-width:none. Дополнительный cross-route guard выявил слишком широкое применение user DTO admin и WebAuthn options (`other` вместо `self`), исправлено allowlist authoritative current-account routes.

Геометрию viewport DOM fixture не моделирует. Root CUA подтвердил cabinet→QR при 375×812: полный QR с quiet zone y262–483, focus «Закрыть», без ручной прокрутки. Checkout-success проверен исполнением фактического helper path в DOM regression, отдельного CUA подтверждения нет. Реальные операции провайдера или двери не выполнялись.
