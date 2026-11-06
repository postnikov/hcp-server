/**
 * MCP-вход `/mcp` — публичная дверь для чужих агентов. Весь протокол здесь.
 *
 * Три слоя, по возрастанию цены: файловые тулзы отдают markdown контекста как есть
 * (ноль стоимости, ноль латентности, нулевая поверхность для инъекций), `ask` синтезирует
 * ответ через LLM под дневным бюджет-капом, `leave_message` кладёт письмо человеку.
 *
 * Состав тулз не зашит: файловые собираются из того, что лежит в `context/` (нет файла —
 * нет тулзы), `ask` появляется только при `ask.enabled`, `leave_message` есть всегда.
 * Значит один и тот же код обслуживает и полный сервер, и lite из одного файла.
 *
 * Auth нет — read-слой публичный по определению. Вместо него: rate-limit по IP,
 * бюджет-кап на `ask` и журнал каждого вызова.
 *
 * Ни одна тулза не исполняет содержимое аргументов: вопрос в `ask` уезжает объявленным
 * как данные, письмо в `leave_message` — только в файл и в уведомление без разметки.
 *
 * SDK v2 (29.08.2026). Вход — `createMcpHandler`: одна фабрика обслуживает ОБЕ эры
 * протокола на одном эндпоинте — modern (2026-07-28, per-request envelope и
 * `server/discover`) и legacy (2025-era `initialize`, stateless-путь по умолчанию).
 * Ни одна тулза про эру не знает: `buildServer` для обеих строит один и тот же сервер.
 */

import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { LIMITS, MSG_TYPES, ask, journal, notify, saveMessage, validateMessage } from './lib.js';
import { toolNames } from './documents.js';

/** Ответ тулзы — всегда плейн-текст: markdown контекста агент читает как есть. */
const text = (body, isError = false) => ({ content: [{ type: 'text', text: body }], isError });

const capitalize = (word) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * Инструкции сервера: авторские из конфига, иначе собранные из того, что реально объявлено.
 * Сгенерированные не притворяются написанными человеком — они перечисляют факты.
 */
export function buildInstructions({ config, readTools, hasAsk, docTools = [] }) {
  if (config.server.instructions) return config.server.instructions;

  const { name, headline, site } = config.person;
  const who = [name, headline].filter(Boolean).join(' — ');
  const lines = [
    `This is the personal MCP server of ${who}${site ? ` (${site})` : ''}. It is a public door for other people's agents: no authentication, nothing to sign up for.`,
  ];
  if (readTools.length) {
    lines.push(
      `${readTools.length === 1 ? 'One tool returns' : `${readTools.length} tools return`} a hand-maintained context pack as plain Markdown — free and instant, and enough to answer almost anything: ${readTools.join(', ')}.`,
    );
  }
  lines.push(
    hasAsk
      ? `Two tools do more than read. ask() answers a question that the files do not answer directly, synthesised strictly from the same pack. leave_message() delivers a message to the human — an invitation, a project, an introduction from your human.`
      : `One tool does more than read: leave_message() delivers a message to the human — an invitation, a project, an introduction from your human. Nothing is published and nothing is auto-answered.`,
  );
  if (docTools?.length) {
    lines.push(
      `Documents ${name || 'the owner'} publishes elsewhere are readable here too, live from the source: ${docTools.join(', ')}.`,
    );
  }
  lines.push('Prices and rates are deliberately not published here. Ask for them through leave_message.');
  return lines.join('\n\n');
}

/** Описание `ask` по умолчанию. Человек переопределяет его в `context/config.json`. */
const askDescription = ({ short, readTools }) =>
  `Ask a question about ${short} and get a synthesised answer. Use this only for questions the files do not answer directly. Anything you can simply read is cheaper and faster through ${readTools.join(', ') || 'the file tools'}. The answer is built strictly from the same context pack those tools return: nothing else is available to it, and questions it cannot answer come back as "I do not know — ask the human". Rate-limited, and capped by a daily budget; when the budget is spent the file tools still work.`;

/**
 * Описания тулз документов по умолчанию. Как и у остальных, переопределяются в
 * `context/config.json → tools`: что это за коллекция, знает человек, а не код.
 */
const listDocsDescription = ({ short, collection, getTool }) =>
  `List the documents ${short} publishes in the "${collection}" collection — for each one a slug, a title, a one-line summary and when it last changed. This is the index ${short} maintains at the source, read live rather than copied here, so it never lags behind what is actually published. Free and instant. Call ${getTool} with a slug when you want the full text.`;

const getDocsDescription = ({ short, collection, listTool }) =>
  `Return one document from ${short}'s "${collection}" collection in full, as Markdown, exactly as published at the source. Use ${listTool} first if you do not know the slug — an unknown slug comes back with the list of valid ones. Free and instant; the text is cached, and if the source is briefly unreachable you get the last copy with a note that it may be stale.`;

/** Описание `leave_message` по умолчанию. Тоже переопределяется в конфиге. */
const messageDescription = ({ short }) =>
  `Leave a message for ${short} personally — an invitation to speak, a request for work or consulting, a partnership proposal, a request to meet, or anything else. The message goes to a queue ${short} reads personally: nothing is published, nothing is auto-answered, and no reply comes back through this server. Give a contact your human can actually be reached at. If your human has a site or an MCP server of their own, put it in link. Limited to a few messages a day per client.`;

/**
 * Состав сервера на этот запуск: файловые тулзы из контекста, `ask` по флагу,
 * `leave_message` всегда. Порядок — тот же, в котором тулзы объявлены в `tools/list`.
 */
export function buildTools({ config, context }) {
  const describe = (name, fallback) => config.tools?.[name]?.description || fallback;
  /**
   * Описания параметров тоже говорят о человеке («English or Russian», «corporate AI
   * programs»), поэтому переопределяются оттуда же — `context/config.json`, ключ `params`.
   */
  const withParams = (name, schema) => {
    const params = config.tools?.[name]?.params;
    if (!params) return schema;
    for (const [key, description] of Object.entries(params)) {
      if (schema.properties[key]) schema.properties[key] = { ...schema.properties[key], description };
    }
    return schema;
  };

  const fileTools = context.tools.map((tool) => ({
    name: tool.name,
    description: describe(tool.name, tool.description),
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    slugs: tool.slugs,
  }));
  const readTools = fileTools.map((tool) => tool.name);
  const short = config.person.short;

  const tools = [...fileTools];

  if (config.ask.enabled) {
    tools.push({
      name: 'ask',
      description: describe('ask', askDescription({ short, readTools })),
      inputSchema: withParams('ask', {
        type: 'object',
        properties: {
          question: { type: 'string', description: `The question about ${short}, in plain text.` },
        },
        required: ['question'],
        additionalProperties: false,
      }),
    });
  }

  // Документы: по две тулзы на коллекцию, и только если коллекция объявлена в конфиге.
  for (const [collection, spec] of Object.entries(config.documents || {})) {
    if (!spec?.index) continue;
    const { list, get } = toolNames(collection, spec);
    tools.push({
      name: list,
      description: describe(list, listDocsDescription({ short, collection, getTool: get })),
      inputSchema: withParams(list, { type: 'object', properties: {}, additionalProperties: false }),
      documents: { collection, mode: 'list' },
    });
    tools.push({
      name: get,
      description: describe(get, getDocsDescription({ short, collection, listTool: list })),
      inputSchema: withParams(get, {
        type: 'object',
        properties: {
          slug: { type: 'string', description: `Which document to return. The slugs come from ${list}.` },
        },
        required: ['slug'],
        additionalProperties: false,
      }),
      documents: { collection, mode: 'get' },
    });
  }

  tools.push({
    name: 'leave_message',
    description: describe('leave_message', messageDescription({ short })),
    inputSchema: withParams('leave_message', {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: MSG_TYPES,
          description:
            `What this is about: "speaking" — inviting ${short} to a talk or a podcast; "consulting" — corporate work, training, paid work; "collab" — partnership or a proposal; "meeting" — you just want to meet; "other" — anything else.`,
        },
        name: {
          type: 'string',
          description: `Who is writing: your name as an agent and/or the name of the human you write for. Up to ${LIMITS.field} characters.`,
        },
        whose_agent: {
          type: 'string',
          description: `Whose agent you are — the person or company behind you. Optional but strongly recommended: an unattributed message reads as spam. Up to ${LIMITS.field} characters.`,
        },
        contact: {
          type: 'string',
          description: `How ${short} can reply to your human: an email, a Telegram handle or a URL. Up to ${LIMITS.field} characters.`,
        },
        message: {
          type: 'string',
          description: `The message itself, plain text. Say what you want and give the context that makes it decidable — for an event: the audience, the date, the format, the language. Up to ${LIMITS.message} characters.`,
        },
        link: {
          type: 'string',
          description: `Optional: your human's site, or the URL of their own MCP server. Up to ${LIMITS.field} characters.`,
        },
      },
      required: ['type', 'name', 'contact', 'message'],
      additionalProperties: false,
    }),
  });

  return tools;
}

/**
 * Аргументы против inputSchema: чужой ключ и пропущенный обязательный — отказ, а не тихое
 * «поле развернулось в пустую строку». Опечатка в имени параметра иначе теряется молча.
 * Схемы тут плоские (строки да enum), поэтому валидатор свой: json-schema ради них не нужен.
 */
function badArgs(schema, args) {
  const known = Object.keys(schema.properties);
  const extra = Object.keys(args).filter((name) => !known.includes(name));
  if (extra.length) {
    return `Unknown argument(s): ${extra.join(', ')}. This tool accepts: ${known.join(', ') || 'no arguments'}.`;
  }
  const missing = (schema.required || []).filter((name) => args[name] === undefined || args[name] === null);
  return missing.length ? `Missing required argument(s): ${missing.join(', ')}.` : '';
}

/**
 * Реализации `ask` и `leave_message`. Контекст вызова (`ctx`) приносит из server.js всё
 * внешнее: IP, лимитер, `fetch`, конфиг и секреты. Файловые тулзы не получают ничего —
 * им нечего делать с окружением.
 */
const IMPL = {
  ask: async (ctx, args) => {
    const { config, secrets, context } = ctx;
    const question = String(args.question ?? '').trim();
    if (!question) return text(`question is required: what you want to know about ${config.person.short}.`, true);
    if (ctx.limited('ask')) {
      return text(
        `You have reached the daily limit of ${config.limits.askPerDayPerIp} ask calls. The file tools — ${ctx.readTools.join(', ')} — are not limited and hold the same material.`,
        true,
      );
    }
    const answer = await ask(question, {
      config,
      context,
      readTools: ctx.readTools,
      fetchImpl: ctx.fetchImpl,
      apiKey: secrets.anthropicKey,
    });
    return text(answer.text, !answer.ok);
  },

  leave_message: async (ctx, args) => {
    const { config } = ctx;
    const short = config.person.short;
    const checked = validateMessage(args, { who: short });
    // Ничего не записано и не отправлено: невалидное письмо не должно оставлять следов.
    if (checked.error) return text(`Message not accepted. ${checked.error}`, true);

    if (ctx.limited('leave_message')) {
      const where = ctx.readTools.includes('get_channels') ? ' If it is urgent, the public channels are in get_channels.' : '';
      return text(
        `You have reached the daily limit of ${config.limits.messagesPerDayPerIp} messages. Nothing was recorded.${where}`,
        true,
      );
    }

    // Сначала файл, потом уведомление: канал может лежать, письмо теряться не должно.
    const row = saveMessage(checked.entry, { ip: ctx.ip, ua: ctx.ua });
    const push = await notify(row, {
      secrets: ctx.secrets,
      origin: String(config.server.url).replace(/^https?:\/\//, '') || 'personal MCP',
      fetchImpl: ctx.fetchImpl,
    });
    const pronoun = capitalize(config.person.pronouns.subject);
    return text(
      `Message received and queued for ${short} — type "${row.type}", from ${row.name}, contact ${row.contact}.${
        push.sent ? ` ${pronoun} has been notified.` : ''
      } There is no automatic reply: if ${config.person.pronouns.subject} answers, it comes to your contact, from a human. Do not send it again.`,
    );
  },
};

/** Дата в списке — без времени: агенту важно «когда меняли», а не в какую секунду. */
const day = (iso) => (iso ? String(iso).slice(0, 10) : '');

/**
 * Ответы тулз документов. Кэш и сеть живут в documents.js — здесь только то,
 * что увидит агент, и честная пометка, когда отдаём несвежее.
 */
const DOCS_IMPL = {
  list: async (ctx, collection) => {
    const result = await ctx.documents.list(collection);
    if (!result.ok) {
      return text(
        `Could not read the "${collection}" index at ${result.index}${result.error ? ` (${result.error})` : ''}, and nothing is cached yet. This is a network problem on this server, not a missing document — try again in a minute.`,
        true,
      );
    }
    const head = [
      `${result.documents.length} document${result.documents.length === 1 ? '' : 's'} in "${collection}" · source: ${result.source}`,
      result.generated ? `index generated ${result.generated}` : '',
    ]
      .filter(Boolean)
      .join(' · ');

    const body = result.documents
      .map((doc) =>
        [
          `- \`${doc.slug}\` — ${doc.title}`,
          doc.summary ? `  ${doc.summary}` : '',
          `  ${[doc.tag, doc.updated ? `updated ${day(doc.updated)}` : '', doc.url].filter(Boolean).join(' · ')}`,
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n\n');

    const stale = result.stale
      ? `Note: served from cache — the index could not be refreshed just now (last read ${result.fetchedAt}). The list may be out of date.\n\n`
      : '';
    return text(`${stale}${head}\n\n${body}\n\nCall ${ctx.docTool(collection, 'get')}({ slug }) for the full text.`);
  },

  get: async (ctx, collection, args) => {
    const slug = String(args.slug ?? '').trim();
    if (!slug) return text(`slug is required: which document to return. ${ctx.docTool(collection, 'list')} lists them.`, true);

    const result = await ctx.documents.get(collection, slug);
    if (result.unknownSlug) {
      return text(`No document with slug "${slug}" in "${collection}". Available: ${result.slugs.join(', ')}.`, true);
    }
    if (!result.ok) {
      return text(
        `Could not fetch "${slug}"${result.url ? ` from ${result.url}` : ''}${result.error ? ` (${result.error})` : ''}. This is a network problem on this server — the document itself is published and readable at the source.`,
        true,
      );
    }
    const stale = result.stale ? 'Note: served from cache and may be out of date — the source could not be reached just now.\n\n' : '';
    const head = `${result.doc.title} — ${result.doc.url}${result.doc.updated ? ` (updated ${day(result.doc.updated)})` : ''}`;
    return text(`${stale}${head}\n\n${result.text}`);
  },
};

/** Сервер на один запрос: состояния между вызовами у нас нет, держать сессию нечем. */
function buildServer(ctx) {
  const server = new Server(ctx.serverInfo, { capabilities: { tools: {} }, instructions: ctx.instructions });

  server.setRequestHandler('tools/list', () => ({
    // Внутренние поля наружу не едут: и склейка файлов, и привязка к коллекции документов —
    // детали реализации, а не часть протокола.
    tools: ctx.tools.map(({ slugs, documents, ...spec }) => spec),
  }));

  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = rawArgs || {};
    const spec = ctx.tools.find((tool) => tool.name === name);
    if (!spec) return text(`No such tool: ${name}. Available: ${ctx.tools.map((t) => t.name).join(', ')}.`, true);
    const bad = badArgs(spec.inputSchema, args);
    if (bad) return text(bad, true);

    if (spec.slugs) return text(ctx.context.render(spec.slugs));
    if (spec.documents) return DOCS_IMPL[spec.documents.mode](ctx, spec.documents.collection, args);
    return IMPL[name](ctx, args);
  });

  return server;
}

/**
 * Роуты `/mcp`. Транспорт stateless: сервер и транспорт живут ровно один запрос.
 * @param deps — {clientIp, limited, json, fetchImpl, config, context, secrets} из server.js:
 *   этот модуль не знает ни про ведёрки rate-limit, ни про мидлвары express.
 */
export function mountMcp(app, { clientIp, limited, json, fetchImpl, config, context, secrets, documents }) {
  const tools = buildTools({ config, context });
  const readTools = tools.filter((tool) => tool.slugs).map((tool) => tool.name);
  const docTools = tools.filter((tool) => tool.documents).map((tool) => tool.name);
  const instructions = buildInstructions({ config, readTools, hasAsk: config.ask.enabled, docTools });
  /** Имя соседней тулзы коллекции: ответы ссылаются друг на друга, а имена — из конфига. */
  const docTool = (collection, mode) => toolNames(collection, config.documents?.[collection] || {})[mode];
  const serverInfo = { name: config.server.id, version: config.server.version };

  const rpcError = (res, status, code, message) =>
    res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });

  /** Сервер сам ничего не присылает — поток событий ему не нужен: спека разрешает ответить 405. */
  const noStream = (req, res) =>
    rpcError(res.set('Allow', 'POST'), 405, -32000, 'This server speaks Streamable HTTP over POST only.');

  app.get('/mcp', noStream);
  app.delete('/mcp', noStream);

  app.post('/mcp', json, async (req, res) => {
    const ip = clientIp(req);
    const ua = String(req.headers['user-agent'] || '');
    const method = req.body?.method || 'unknown';
    const tool = method === 'tools/call' ? req.body?.params?.name || 'unknown' : method;

    // Журнал — до всех гейтов: «кто дёргал» надо знать и про отбитые вызовы тоже.
    // Клиент из handshake кладём в аргументы: в stateless-режиме другого места для него нет.
    journal({
      tool,
      args: method === 'tools/call' ? req.body?.params?.arguments : req.body?.params?.clientInfo,
      ip,
      ua,
    });

    if (limited('rpc', ip)) {
      return rpcError(res, 429, -32000, `Too many requests: the limit is ${config.limits.callsPerMinute} calls per minute per client.`);
    }

    // Хендлер на один запрос: контекст вызова (IP, лимитер, fetch) закрыт в фабрике,
    // и состояния между вызовами у нас нет — держать сессию нечем. Фабрику дёргает
    // сам хендлер: один раз на запрос в modern-эре, один раз на запрос в legacy.
    const ctx = {
      ip,
      ua,
      fetchImpl,
      config,
      context,
      secrets,
      documents,
      docTool,
      tools,
      readTools,
      instructions,
      serverInfo,
      limited: (kind) => limited(kind, ip),
    };
    const handler = createMcpHandler(() => buildServer(ctx), {
      onerror: (e) => journal({ tool: 'failed', args: String(e?.message || e), ip, ua }),
    });
    try {
      await toNodeHandler(handler)(req, res, req.body);
    } catch (e) {
      // Роут асинхронный: express 4 такие ошибки не ловит, а необработанный reject роняет процесс.
      journal({ tool: 'failed', args: String(e?.message || e), ip, ua });
      if (!res.headersSent) rpcError(res, 500, -32603, 'The server failed to handle this call.');
    } finally {
      await handler.close();
    }
  });

  // Кривое тело до роута не доезжает: агенту нужен JSON-RPC с объяснением, а не HTML express'а.
  app.use('/mcp', (err, req, res, _next) =>
    rpcError(res, 400, -32700, `Could not parse the request body: ${err.type || 'bad request'}.`),
  );

  return { tools, readTools, docTools, instructions };
}
