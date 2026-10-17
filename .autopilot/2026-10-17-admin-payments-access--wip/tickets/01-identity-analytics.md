# 01 — Серверные аккаунты и данные администратора

**Требования:** R01, R02, R03, R04, R06, R07, G01
**Зависит от:** —
**Зона:** `server.py` · `identity.py` · `analytics.py` · `requirements.txt` · `tests/test_identity.py` · `tests/test_analytics.py`
**Волна:** 1
**Ревью:** да — фундамент, авторизация и деньги в статистике
**Модель:** сильная

## Что должно заработать
Настоящие серверные регистрации и парольный/WebAuthn вход. Защищённый реестр всех аккаунтов и понятные исходные данные аналитики доступны по HTTP. Аддитивная миграция, владение бронями по аккаунту и по гостевой cookie сохранены. Установить все зависимости spec, включая QR для02; заморозить фактические schema/seams в return.

## Из брифа, дословно
> «личный кабинет администратора», «видеть пользователей, их регистрации, статистику с графиками понятными», «статисктку по выручке и оплате»
> «давай аккаунт сделаем через отпечато или пароль.»

## Разделы спецификации
Истории R01–R04/G01, R06/R07; Решения; interfaces целиком. Сначала существующие notes и provider research.

## Критерии приёмки
- [ ] Новая регистрация с паролем/явными документами попадает в SQLite и admin users без брони; старые данные целы, local fake users не импортируются.
- [ ] scrypt+salt, validation/throttling, generic login errors, session rotation/logout, CSRF, cross-device booking ownership; чужая бронь по совпадающему телефону недоступна.
- [ ] Passkey register/login реально проверяют подписанный response библиотекой с UP/UV/challenge/origin/RPID/TTL/одноразовостью; credential listing/deletion только свой. Локальный mock authenticator подписывает valid and invalid assertions в тестах, не подменять verifier на true.
- [ ] Серверный profile/update/password сохраняет права; registration consent revisions и возраст/guardian проверяются, нет авто-согласия. Контракт совместимых полей и consent input явно вернуть для03.
- [ ] Admin users paginated/search и analytics totals/zero-filled series/statuses/methods за valid period, денежные события Москва/копейки/test segregation; текущие dashboard методы не сломаны.
- [ ] Capabilities/integrations не содержат секретов, configured origin/host/cookie Secure поддерживает будущий HTTPS и passkeys; factory create_server совместим. Схемы payments/access placeholders не выдают работающую интеграцию.
- [ ] Установлены и зафиксированы webauthn==3.0.1, qrcode==8.2+runtime transitive pins. Один check node tests/check.mjs зелёный.
