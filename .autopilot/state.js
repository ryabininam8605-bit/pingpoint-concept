window.STATE =
{
  "version": 2,
  "slug": "booking-partners-fixes",
  "dir": "2026-10-17-booking-partners-fixes--wip",
  "title": "Ping Point: занятость и объявления",
  "mode": "semi",
  "depth": "normal",
  "tier": "T1",
  "briefFile": "2026-10-17-brief.md",
  "memoryFile": "AGENTS.md",
  "memoryOwner": "autopilot",
  "skillDir": "C:\\Users\\DIR-PC\\.agents\\skills\\autopilot",
  "baseCommit": null,
  "startedAt": "2026-10-17T15:15:54+03:00",
  "updatedAt": "2026-10-17T15:19:28+03:00",
  "finishedAt": null,
  "stages": [
    {
      "id": "preflight",
      "status": "done",
      "startedAt": "2026-10-17T15:15:54+03:00",
      "finishedAt": "2026-10-17T15:16:12+03:00"
    },
    {
      "id": "manifest",
      "status": "done",
      "startedAt": "2026-10-17T15:16:12+03:00",
      "finishedAt": "2026-10-17T15:18:32+03:00"
    },
    {
      "id": "briefing",
      "status": "done",
      "startedAt": "2026-10-17T15:18:32+03:00",
      "finishedAt": "2026-10-17T15:18:40+03:00"
    },
    {
      "id": "spec",
      "status": "done",
      "startedAt": "2026-10-17T15:18:40+03:00",
      "finishedAt": "2026-10-17T15:19:07+03:00"
    },
    {
      "id": "plan",
      "status": "active",
      "startedAt": "2026-10-17T15:19:07+03:00"
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
    "total": 7,
    "done": 0,
    "inTicket": 7,
    "inSpec": 0,
    "placeholder": 0,
    "deferred": 0,
    "dropped": 0
  },
  "tickets": [
    {
      "id": "01",
      "title": "Общий сервер бронирования",
      "requirements": [
        "R01",
        "R02"
      ],
      "blockedBy": [],
      "wave": 1,
      "zone": [],
      "review": "да — фундамент, доступ и деньги",
      "model": "сильная",
      "status": "pending",
      "retries": 0,
      "repairs": 0
    },
    {
      "id": "02",
      "title": "Понятные цены и рабочая публикация",
      "requirements": [
        "R01",
        "R02",
        "R03",
        "R04",
        "R05",
        "R06",
        "R07"
      ],
      "blockedBy": [
        "01"
      ],
      "wave": 2,
      "zone": [],
      "review": "да — согласия, расчёт и брони",
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
    "found": 2,
    "fixed": 2,
    "deferred": 0,
    "items": []
  },
  "concerns": [],
  "blind": null,
  "beats": [
    "2026-10-17T15:15:54+03:00",
    "2026-10-17T15:16:12+03:00",
    "2026-10-17T15:16:19+03:00",
    "2026-10-17T15:16:31+03:00",
    "2026-10-17T15:18:32+03:00",
    "2026-10-17T15:18:40+03:00",
    "2026-10-17T15:19:00+03:00",
    "2026-10-17T15:19:07+03:00",
    "2026-10-17T15:19:14+03:00",
    "2026-10-17T15:19:21+03:00",
    "2026-10-17T15:19:28+03:00"
  ],
  "rev": 12,
  "waiting": null,
  "waits": [
    {
      "kind": "briefing",
      "from": "2026-10-17T15:16:31+03:00",
      "to": "2026-10-17T15:18:32+03:00"
    }
  ],
  "log": [
    {
      "t": "2026-10-17T15:15:54+03:00",
      "k": "init"
    },
    {
      "t": "2026-10-17T15:16:12+03:00",
      "k": "stage",
      "id": "manifest",
      "act": "start"
    },
    {
      "t": "2026-10-17T15:16:31+03:00",
      "k": "ask",
      "kind": "briefing",
      "note": "Общий источник бронирований: этот сайт или действующая система"
    },
    {
      "t": "2026-10-17T15:18:32+03:00",
      "k": "answered",
      "kind": "briefing"
    },
    {
      "t": "2026-10-17T15:18:32+03:00",
      "k": "stage",
      "id": "briefing",
      "act": "start"
    },
    {
      "t": "2026-10-17T15:18:40+03:00",
      "k": "gate",
      "g": "G1",
      "ok": true,
      "open": 0,
      "total": 7
    },
    {
      "t": "2026-10-17T15:18:40+03:00",
      "k": "stage",
      "id": "spec",
      "act": "start"
    },
    {
      "t": "2026-10-17T15:19:00+03:00",
      "k": "gate",
      "g": "G2",
      "ok": true,
      "found": 2,
      "fixed": 2,
      "deferred": 0
    },
    {
      "t": "2026-10-17T15:19:07+03:00",
      "k": "stage",
      "id": "plan",
      "act": "start"
    },
    {
      "t": "2026-10-17T15:19:14+03:00",
      "k": "tier",
      "v": "T1"
    },
    {
      "t": "2026-10-17T15:19:21+03:00",
      "k": "tickets",
      "n": 2
    },
    {
      "t": "2026-10-17T15:19:28+03:00",
      "k": "gate",
      "g": "G3",
      "ok": false,
      "problems": 2
    }
  ],
  "reqList": [
    {
      "id": "R01",
      "text": "«при нажатии кнопка время должно выдавать свободное время комнаты не занятой бронированием на сайте»",
      "status": "in-ticket"
    },
    {
      "id": "R02",
      "text": "«если забронировал занято»",
      "status": "in-ticket"
    },
    {
      "id": "R03",
      "text": "«при просчете на компаанию убери упоминнания о фитнесклуюбе»",
      "status": "in-ticket"
    },
    {
      "id": "R04",
      "text": "«если выбираешь утро с 10 до 13, то конкретно, должно выбираться в этом диапазоне»",
      "status": "in-ticket"
    },
    {
      "id": "R05",
      "text": "«иногда дальше не возможно дальше совершить шаги, подать объявление»",
      "status": "in-ticket"
    },
    {
      "id": "R06",
      "text": "«убери эти уебищнай прокрутки»",
      "status": "in-ticket"
    },
    {
      "id": "R07",
      "text": "«четвертое фото не свосем понятно как это считать?»",
      "status": "in-ticket"
    }
  ],
  "gates": {
    "G1": {
      "ok": true,
      "at": "2026-10-17T15:18:40+03:00",
      "open": 0,
      "total": 7
    },
    "G2": {
      "ok": true,
      "at": "2026-10-17T15:19:00+03:00",
      "found": 2,
      "fixed": 2,
      "deferred": 0
    },
    "G3": {
      "ok": false,
      "at": "2026-10-17T15:19:28+03:00",
      "problems": 2
    }
  },
  "result": null
}
