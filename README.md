# Personal MCP server

Твой личный MCP-сервер: публичная дверь, за которой чужие агенты читают твой
контекст и оставляют тебе письмо. Auth нет и не будет — read-слой публичный по
определению.

Это одновременно **референс** (по нему живёт `postnikov.ai/mcp`) и **шаблон**:
код обезличен, всё личное лежит в `context/`, который в git не едет. Форкнул,
положил свои файлы, поднял — получил свой сервер по стандарту
[HCP](https://github.com/postnikov/hcp-protocol).

## За пять минут

```bash
# 1. Свой экземпляр — кнопкой «Use this template» на GitHub, или локально:
git clone https://github.com/postnikov/hcp-server.git my-mcp
cd my-mcp && rm -rf .git && git init
npm install

# 2. Личный слой
cp -r context.example context
$EDITOR context/who.md          # минимум — один этот файл
$EDITOR context/config.json     # имя, домен, лимиты

# 3. Проверка на месте
npm test
npm start                       # http://localhost:3000/mcp

# 4. Подключить агента
claude mcp add --transport http me http://localhost:3000/mcp
```

Наполнить `context/` можно не руками: промпт
`prompts/generate-my-hcp.md` из [`hcp-protocol`](https://github.com/postnikov/hcp-protocol)
собирает эти файлы из твоих материалов — CV, постов, README проектов, транскриптов
выступлений — и задаёт вопросы только там, где материалов не хватило. Подробности —
в `context.example/README.md`.

## Сервер отдаёт то, что у тебя есть

**Тулзы объявляются по наличию файлов.** Нет `speaking.md` — нет и `get_speaking`
в `tools/list`: агент не получает пустой ответ на тулзу, которой у тебя нет.
Положишь `context/reading.md` — появится `get_reading`, править код не надо.

| Файл в `context/` | Тулза |
|---|---|
| `who.md` + `now.md` | `get_profile` |
| `speaking.md` | `get_speaking` |
| `services.md` | `get_services` |
| `channels.md` | `get_channels` |
| `writing.md` | `get_writing` |
| любой свой `X.md` | `get_X` |

Плюс две тулзы поверх файлов:

| Тулза | Что делает |
|---|---|
| `ask` | синтез-ответ на вопрос, которого нет в файлах напрямую. **Выключена по умолчанию**: единственное, что стоит денег |
| `leave_message` | письмо тебе лично: строка в `data/inbox.jsonl` плюс уведомление, если настроил канал |

Минимум для запуска — **один файл**. `who.md` и больше ничего: сервер поднимется
с двумя тулзами (`get_profile`, `leave_message`). Ноль файлов — сервер не
стартует и говорит почему; пустой сервер хуже отсутствующего.

Каждый вызов пишется в `data/journal.jsonl` — это сенсор «кто вообще приходит к
личному MCP».

## Личный слой: что где лежит

```
context/                  ← твоё, в git не едет (.gitignore)
  config.json             имя, домен, лимиты, переопределения описаний
  *.md                    файлы контекста; YAML-шапка задаёт тулзу и её описание
  deploy.env              адрес VPS и домен — только для deploy.sh
context.example/          ← шаблон того же самого, коммитится
.env                      ← секреты, на сервере; шаблон — .env.example
```

Файл контекста может нести шапку — она не уезжает агентам:

```markdown
---
tool: get_speaking
title: Speaking
for_agent: >
  Что внутри и когда это стоит дёрнуть. Агент читает это ДО вызова тулзы.
---
# Speaking — Твоё Имя
```

Шапки нет — работает конвенция из `config.json → context.groups`, дальше
`get_<имя файла>`. Описание не задано — соберётся честный однострочник.

Всё, что сервер говорит о тебе, приезжает из `context/`: в `src/` нет ни одного
личного слова. Это проверяется тестом, а не обещанием.

## Переменные окружения

Всё опционально: без единой переменной сервер отдаёт файлы и принимает письмо.
Комментированный образец — `.env.example`.

| Переменная | Что даёт |
|---|---|
| `ASK_ENABLED` | включает тулзу `ask` (можно и в `config.json`) |
| `ANTHROPIC_API_KEY` | ключ для `ask`. **BYOK**: платишь ты |
| `ASK_MODEL`, `ASK_CALLS_PER_DAY`, `ASK_TOKENS_PER_DAY` | модель и суточные потолки |
| `NOTIFY_TG_BOT_TOKEN`, `NOTIFY_TG_CHAT_ID` | пуш в Telegram о входящем письме |
| `NOTIFY_RESEND_API_KEY`, `NOTIFY_EMAIL_TO`, `NOTIFY_EMAIL_FROM` | то же письмом, через HTTP API Resend |
| `SERVE_DISCOVERY` | отдавать ли свои `/llms.txt` и server-card (по умолчанию да) |
| `MCP_PUBLIC_URL` | публичный адрес `/mcp` |
| `PORT`, `DATA_DIR`, `CONTEXT_DIR` | где слушать, где данные, где личный слой |

Секреты только через env: в коде, конфигах и git их нет.

## Лимиты и деньги

| Что | По умолчанию | Где живёт |
|---|---|---|
| Все вызовы | 60/мин на IP | в памяти процесса |
| `ask` | 10/сутки на IP | в памяти процесса |
| `leave_message` | 5/сутки на IP | в памяти процесса |
| `ask` — вызовы | 20/сутки суммарно | `data/budget.json`, переживает рестарт |
| `ask` — токены | 150 000/сутки суммарно | `data/budget.json`, переживает рестарт |

Суточные капы `ask` — money-safety: per-IP лимита мало, потому что IP у агентов
бесплатные. Исчерпан любой из двух — тулза отказывает, **не обращаясь к API**, и
перечисляет бесплатные файловые тулзы. Сброс в 00:00 UTC. Цифры — в
`context/config.json → ask`.

## Discovery

При `discovery.enabled` сервер сам отдаёт:

- `/.well-known/mcp/server-card.json` — по реестровой схеме MCP (2025-09-29):
  reverse-DNS имя, описание до 100 символов, `remotes[].type: streamable-http`;
- `/llms.txt` — то же для агента, который читает текст, а не JSON.

Оба собираются из конфига и **реального** состава тулз, поэтому обещать
несуществующее им нечем. Если эти файлы на твоём домене уже раздаёт сайт —
`SERVE_DISCOVERY=0`, две правды хуже одной.

## Протокол: две эры на одном эндпоинте

Сервер собран на **SDK v2** (`@modelcontextprotocol/server` +
`@modelcontextprotocol/node`) и через `createMcpHandler` обслуживает обе эры
протокола на одном `/mcp`:

- **modern — 2026-07-28**: без `initialize`, версия и клиент едут в per-request
  envelope (`_meta`), метод и имя тулзы дублируются заголовками `Mcp-Method` /
  `Mcp-Name` (SEP-2243), обзор сервера отдаёт `server/discover`. Ответ — JSON.
- **legacy — 2025-era**: обычный `initialize`, версию сервер выбирает по запросу
  клиента (потолок SDK — 2025-11-25). Ответ — **SSE-кадр**, а не JSON: так
  выглядит stateless-путь SDK v2. Для клиента это не изменение контракта —
  200 и раньше получал только тот, кто объявил `Accept: text/event-stream`.

Фабрика одна на обе эры: тулзы, схемы и лимиты не знают, в какой эре их зовут.

## Развернуть на своём VPS

```bash
cp context.example/deploy.env context/deploy.env   # сервер, домен, имена
$EDITOR context/deploy.env
./deploy.sh
```

`deploy.sh` гоняет тесты, показывает превью удалений на проде (гейт на `--delete`),
зеркалит рабочее дерево, грузит `context/deploy.env` в окружение и пересобирает
контейнер, потом смоук по `MCP_PUBLIC_URL`. `.env` и `data/` не пересекают границу:
секреты и журнал живут только на проде.

`docker-compose.yml` рассчитан на traefik: домен, приоритет роутера и certresolver
берутся из `deploy.env`. Приоритет роутера должен быть **выше**, чем у роутера
сайта на том же домене, иначе запросы к `/mcp` уедут на сайт и агент получит
HTML-404 вместо JSON-RPC.

Нет traefik — сними блок `labels`, открой порт наружу и поставь перед сервером
что угодно, что умеет TLS.

## Проверить живой сервер

```bash
# список тулз
curl -s localhost:3000/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq -r '.result.tools[].name'

# файловая тулза
curl -s localhost:3000/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_profile","arguments":{}}}' \
  | jq -r '.result.content[0].text'
```

Ручной curl в modern-эре без `Mcp-Method`/`Mcp-Name` получит `-32020` — это
правильный ответ, а не поломка. Настоящая проверка — официальным MCP-клиентом.

## Что стоит соблюсти

- **Только публичные факты.** Всё в `context/` отдаётся любому агенту без
  авторизации. Ничего про семью, здоровье, финансы и суммы сделок.
- **Цен нет вообще** — «pricing on request, use `leave_message`». Иначе прайс
  окажется в чужом кэше и переживёт там любые твои правки.
- **Контекст читается при старте процесса.** Поправил файл — перезапусти сервер.
- **Ни одна тулза не исполняет содержимое аргументов**: вопрос в `ask` уезжает
  объявленным как данные, письмо в `leave_message` — только в файл и в
  уведомление без разметки. Ломать это не надо.

## Структура

```
context.example/  шаблон личного слоя (context/ — твой, в git не едет)
src/config.js     конфиг: дефолты, context/config.json, env
src/context.js    файлы человека → секции и состав тулз
src/mcp.js        протокол: сборка тулз, схемы, журнал, монтирование /mcp
src/lib.js        состояние на диске, бюджет-кап, валидация, Anthropic + уведомления
src/discovery.js  server-card.json и llms.txt из конфига
src/server.js     express, разбор IP из-за прокси, ведёрки rate-limit, запуск
test.js           node:test на фикстурах, исходящие замоканы
data/             journal.jsonl, inbox.jsonl, budget.json (в git не едет)
```

Зависимостей две: `express` и MCP SDK. Ни ORM, ни БД, ни SMTP-клиента — почта
уходит обычным `fetch`. Так и держим.

## Лицензия

[MIT](LICENSE) — бери, меняй, поднимай у себя, продавай на этом услуги. Атрибуция
нужна только в самом коде (строчка копирайта в `LICENSE`), не на твоём сайте.
Содержимое твоего `context/` в любом случае твоё: код его не касается.
