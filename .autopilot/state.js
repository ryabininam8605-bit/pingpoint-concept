window.STATE =
{
  "version": 2,
  "slug": "admin-payments-access",
  "dir": "2026-10-17-admin-payments-access--wip",
  "title": "Кабинет администратора, ЮKassa и доступ по QR",
  "mode": "semi",
  "depth": "normal",
  "tier": "T2",
  "briefFile": "2026-10-17-brief.md",
  "memoryFile": "AGENTS.md",
  "memoryOwner": "autopilot",
  "skillDir": "C:/Users/DIR-PC/.agents/skills/autopilot",
  "baseCommit": null,
  "startedAt": "2026-10-17T16:16:32+03:00",
  "updatedAt": "2026-10-17T16:30:03+03:00",
  "finishedAt": null,
  "stages": [
    {
      "id": "preflight",
      "status": "done",
      "startedAt": "2026-10-17T16:16:32+03:00",
      "finishedAt": "2026-10-17T16:17:12+03:00"
    },
    {
      "id": "manifest",
      "status": "done",
      "startedAt": "2026-10-17T16:17:12+03:00",
      "finishedAt": "2026-10-17T16:17:27+03:00"
    },
    {
      "id": "briefing",
      "status": "done",
      "startedAt": "2026-10-17T16:17:27+03:00",
      "finishedAt": "2026-10-17T16:27:05+03:00"
    },
    {
      "id": "spec",
      "status": "done",
      "startedAt": "2026-10-17T16:27:05+03:00",
      "finishedAt": "2026-10-17T16:29:08+03:00"
    },
    {
      "id": "plan",
      "status": "active",
      "startedAt": "2026-10-17T16:29:08+03:00"
    },
    {
      "id": "build",
      "status": "pending"
    },
    {
      "id": "review",
      "status": "pending"
    },
    {
      "id": "final",
      "status": "pending"
    }
  ],
  "requirements": {
    "total": 13,
    "done": 0,
    "inTicket": 13,
    "inSpec": 0,
    "placeholder": 0,
    "deferred": 0,
    "dropped": 0
  },
  "tickets": [
    {
      "id": "01",
      "title": "Серверные аккаунты и данные администратора",
      "requirements": [
        "R01",
        "R02",
        "R03",
        "R04",
        "R06",
        "R07",
        "G01"
      ],
      "blockedBy": [],
      "wave": 1,
      "zone": [
        "server.py",
        "identity.py",
        "analytics.py",
        "requirements.txt",
        "tests/test_identity.py",
        "tests/test_analytics.py"
      ],
      "review": "да — фундамент, авторизация и деньги в статистике",
      "model": "сильная",
      "status": "pending",
      "retries": 0,
      "repairs": 0
    },
    {
      "id": "02",
      "title": "ЮKassa и пропуск на время брони",
      "requirements": [
        "R05",
        "R06",
        "R07",
        "R08",
        "R09",
        "R10",
        "R11",
        "G02"
      ],
      "blockedBy": [
        "01"
      ],
      "wave": 2,
      "zone": [
        "server.py",
        "payments.py",
        "access.py",
        "tests/test_payments.py",
        "tests/test_access.py",
        "README.md"
      ],
      "review": "да — платежи и физический доступ",
      "model": "сильная",
      "status": "pending",
      "retries": 0,
      "repairs": 0
    },
    {
      "id": "03",
      "title": "Аккаунт игрока, оплата и QR в кабинете",
      "requirements": [
        "R02",
        "R03",
        "R05",
        "R09",
        "R10",
        "R11",
        "G01",
        "G02"
      ],
      "blockedBy": [
        "01",
        "02"
      ],
      "wave": 3,
      "zone": [
        "1-neon/community.js",
        "1-neon/shared-account.js",
        "1-neon/shared-booking.js",
        "1-neon/booking.js",
        "1-neon/cabinet.html",
        "1-neon/index.html",
        "tests/account-ui.test.mjs",
        "tests/player-flow.test.mjs"
      ],
      "review": "да — пользовательская авторизация и подтверждение оплаты",
      "model": "сильная",
      "status": "pending",
      "retries": 0,
      "repairs": 0
    },
    {
      "id": "04",
      "title": "Пользователи, понятные графики и контроль интеграций",
      "requirements": [
        "R01",
        "R02",
        "R03",
        "R04",
        "R05",
        "R06",
        "R07",
        "R08",
        "R11"
      ],
      "blockedBy": [
        "01",
        "02"
      ],
      "wave": 3,
      "zone": [
        "1-neon/admin.html",
        "1-neon/admin-insights.js",
        "tests/admin-insights.test.mjs"
      ],
      "review": "нет",
      "model": "сильная",
      "status": "pending",
      "retries": 0,
      "repairs": 0
    }
  ],
  "tests": null,
  "debt": {
    "placeholders": [],
    "assumptions": [],
    "emptyEnv": []
  },
  "additions": [],
  "coverage": {
    "found": 0,
    "fixed": 0,
    "deferred": 0,
    "items": []
  },
  "concerns": [],
  "blind": null,
  "beats": [
    "2026-10-17T16:16:32+03:00",
    "2026-10-17T16:17:12+03:00",
    "2026-10-17T16:17:20+03:00",
    "2026-10-17T16:17:27+03:00",
    "2026-10-17T16:17:35+03:00",
    "2026-10-17T16:18:46+03:00",
    "2026-10-17T16:27:02+03:00",
    "2026-10-17T16:27:05+03:00",
    "2026-10-17T16:27:08+03:00",
    "2026-10-17T16:29:08+03:00",
    "2026-10-17T16:29:09+03:00",
    "2026-10-17T16:29:10+03:00",
    "2026-10-17T16:30:02+03:00",
    "2026-10-17T16:30:03+03:00"
  ],
  "rev": 16,
  "waiting": null,
  "waits": [
    {
      "kind": "briefing",
      "from": "2026-10-17T16:17:35+03:00",
      "to": "2026-10-17T16:27:02+03:00"
    }
  ],
  "log": [
    {
      "t": "2026-10-17T16:16:32+03:00",
      "k": "init"
    },
    {
      "t": "2026-10-17T16:17:12+03:00",
      "k": "stage",
      "id": "manifest",
      "act": "start"
    },
    {
      "t": "2026-10-17T16:17:27+03:00",
      "k": "stage",
      "id": "briefing",
      "act": "start"
    },
    {
      "t": "2026-10-17T16:17:35+03:00",
      "k": "ask",
      "kind": "briefing",
      "note": "СКУД, ЮKassa/домен, идентификация игроков и правила входа"
    },
    {
      "t": "2026-10-17T16:18:46+03:00",
      "k": "ask",
      "kind": "briefing",
      "note": "Нужны ответы: модель СКУД, магазин ЮKassa/HTTPS, вход игроков и правила прохода"
    },
    {
      "t": "2026-10-17T16:27:02+03:00",
      "k": "answered",
      "kind": "briefing"
    },
    {
      "t": "2026-10-17T16:27:05+03:00",
      "k": "gate",
      "g": "G1",
      "ok": false,
      "open": 11,
      "total": 11
    },
    {
      "t": "2026-10-17T16:27:05+03:00",
      "k": "stage",
      "id": "spec",
      "act": "start"
    },
    {
      "t": "2026-10-17T16:27:08+03:00",
      "k": "tier",
      "v": "T2"
    },
    {
      "t": "2026-10-17T16:29:08+03:00",
      "k": "stage",
      "id": "plan",
      "act": "start"
    },
    {
      "t": "2026-10-17T16:29:09+03:00",
      "k": "tickets",
      "n": 4
    },
    {
      "t": "2026-10-17T16:29:10+03:00",
      "k": "gate",
      "g": "G3",
      "ok": true,
      "problems": 0
    },
    {
      "t": "2026-10-17T16:30:02+03:00",
      "k": "gate",
      "g": "G2",
      "ok": true,
      "found": 0,
      "fixed": 0,
      "deferred": 0
    },
    {
      "t": "2026-10-17T16:30:03+03:00",
      "k": "gate",
      "g": "G3",
      "ok": true,
      "problems": 0
    }
  ],
  "reqList": [
    {
      "id": "R01",
      "text": "«личный кабинет администратора»",
      "status": "in-ticket"
    },
    {
      "id": "R02",
      "text": "«видеть пользователей»",
      "status": "in-ticket"
    },
    {
      "id": "R03",
      "text": "«их регистрации»",
      "status": "in-ticket"
    },
    {
      "id": "R04",
      "text": "«статистику с графиками понятными»",
      "status": "in-ticket"
    },
    {
      "id": "R05",
      "text": "«к сайту должна быть подключена юкасса»",
      "status": "in-ticket"
    },
    {
      "id": "R06",
      "text": "«статисктку по выручке»",
      "status": "in-ticket"
    },
    {
      "id": "R07",
      "text": "«и оплате»",
      "status": "in-ticket"
    },
    {
      "id": "R08",
      "text": "«так же есть досту пскуд»",
      "status": "in-ticket"
    },
    {
      "id": "R09",
      "text": "«игроки которрые оплатили ... должны получть qr код»",
      "status": "in-ticket"
    },
    {
      "id": "R10",
      "text": "«или зарегистрированны еи опалтили должны получть qr код»",
      "status": "in-ticket"
    },
    {
      "id": "R11",
      "text": "«комната должан допускатьт в назначенный период по этому коду людей»",
      "status": "in-ticket"
    },
    {
      "id": "G01",
      "text": "«давай аккаунт сделаем через отпечато или пароль.»",
      "status": "in-ticket"
    },
    {
      "id": "G02",
      "text": "«повторно в течениии сеанса можно проходить, как срок заканчивается qr не действительный»",
      "status": "in-ticket"
    }
  ],
  "gates": {
    "G1": {
      "ok": false,
      "at": "2026-10-17T16:27:05+03:00",
      "open": 11,
      "total": 11
    },
    "G3": {
      "ok": true,
      "at": "2026-10-17T16:30:03+03:00",
      "problems": 0
    },
    "G2": {
      "ok": true,
      "at": "2026-10-17T16:30:02+03:00",
      "found": 0,
      "fixed": 0,
      "deferred": 0
    }
  },
  "result": null
}
