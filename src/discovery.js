/**
 * Discovery из коробки: `/.well-known/mcp/server-card.json` и `/llms.txt`, собранные
 * из конфига и реального состава тулз. Смысл — чтобы чужой агент, пришедший на домен
 * человека, нашёл дверь, не читая ничей README.
 *
 * Оба файла ОБЕЩАЮТ поведение сервера, поэтому собираются из того же источника, что и
 * `tools/list`: разойтись им негде. Отдаёт их этот же процесс — выключай (`SERVE_DISCOVERY=0`),
 * если на домене их уже раздаёт сайт.
 *
 * Форма карточки — реестровая схема MCP (2025-09-29): `name` в reverse-DNS с одним слешем,
 * `description` до 100 символов, `remotes[].type` только `streamable-http`. Поля старой
 * формы SEP-1649 лежат рядом: схема не запрещает лишнего, а часть клиентов читает их.
 */

import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';

const CARD_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json';

/**
 * Версии протокола в карточке. Сервер держит две эры на одном эндпоинте, и одним
 * числом это не выразить — поэтому их два поля, и каждое значит ровно одно:
 *
 * - `protocolVersion` — то, чем ответит `initialize`. Это потолок 2025-эры, и он
 *   берётся у SDK: апгрейд пакета двигает карточку сам, без правки файла.
 * - `protocolVersions` — обе эры, современная первой. Без него карточка занижала бы
 *   сервер: `server/discover` отдаёт 2026-07-28, а скаляр о нём умалчивает.
 *
 * Скаляр раньше держал 2026-07-28 — и расходился с живым хендшейком (находка Codex
 * 31.08.2026): агент читал карточку, шёл на `initialize` и получал другую версию.
 *
 * Константу современной эры SDK наружу не отдаёт (внутри — `FIRST_MODERN_PROTOCOL_VERSION`),
 * поэтому она здесь литералом. Сверять при апгрейде SDK не в голове: тест поднимает
 * сервер, дёргает `initialize` и `server/discover` и сверяет с карточкой.
 */
export const MODERN_PROTOCOL_VERSION = '2026-07-28';
export const HANDSHAKE_PROTOCOL_VERSION = LATEST_PROTOCOL_VERSION;

/** `https://example.com/x` → `example.com`. Пусто — значит человек не назвал сайт. */
export const host = (url) => {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** `example.com` → `com.example`: реестровое имя обязано быть reverse-DNS. */
export const reverseDns = (hostname) => (hostname ? hostname.split('.').reverse().join('.') : 'local');

/** Описание карточки — не длиннее 100 символов, иначе схема не примет. */
export const cardDescription = ({ config, readTools }) => {
  const own = config.person.headline;
  const line = own || `${config.person.name}'s personal MCP: ${[...readTools, 'leave_message'].join(', ')}.`;
  return line.length <= 100 ? line : `${line.slice(0, 97).trimEnd()}...`;
};

export function serverCard({ config, readTools }) {
  const url = config.server.url;
  const site = config.person.site;
  const name = `${reverseDns(host(site) || host(url))}/${config.server.id}`;

  return {
    $schema: CARD_SCHEMA,
    name,
    version: config.server.version,
    description: cardDescription({ config, readTools }),
    ...(site ? { websiteUrl: site } : {}),
    // Публичный адрес не назван — адреса в карточке нет вовсе: пустой url хуже,
    // чем отсутствующий, потому что агент по нему пойдёт.
    ...(url ? { remotes: [{ type: 'streamable-http', url }], transport: { type: 'streamable-http', endpoint: url } } : {}),
    // Что вернёт `initialize`, и обе эры рядом — см. комментарий к константам выше.
    protocolVersion: HANDSHAKE_PROTOCOL_VERSION,
    protocolVersions: [MODERN_PROTOCOL_VERSION, HANDSHAKE_PROTOCOL_VERSION],
    serverInfo: { name: config.server.id, title: config.person.name, version: config.server.version },
    // Ровно то, что объявляет handshake. Обещать resources/prompts, которых нет, — врать.
    capabilities: { tools: {} },
    authentication: { required: false },
  };
}

/** `llms.txt` — та же правда для агента, который читает текст, а не JSON. */
export function llmsTxt({ config, tools }) {
  const { headline, site } = config.person;
  const url = config.server.url;
  // Адреса нет — печатаем плейсхолдер, а не пустоту: агент должен видеть, чего не хватает.
  const endpoint = url || 'https://your-domain.example/mcp';
  const card = new URL('/.well-known/mcp/server-card.json', endpoint).href;

  const lines = [`# ${config.person.name}`, ''];
  if (headline) lines.push(`> ${headline}`, '');
  lines.push(
    `This is a personal MCP server built to the HCP shape: a public door for other people's agents. No authentication, nothing to sign up for.`,
    '',
    '## Connect',
    '',
    '```',
    `claude mcp add --transport http ${config.server.connectAs} ${endpoint}`,
    '```',
    '',
    '## Tools',
    '',
  );
  for (const tool of tools) lines.push(`- \`${tool.name}\` — ${tool.description}`);
  lines.push('', '## Links', '');
  if (site) lines.push(`- Website: ${site}`);
  lines.push(`- Server card: ${card}`, '');
  return lines.join('\n');
}

/** Роуты. Ничего не пишут и ни от чего не зависят — обычная статика, собранная в памяти. */
export function mountDiscovery(app, { config, tools, readTools }) {
  const card = serverCard({ config, readTools });
  const txt = llmsTxt({ config, tools });

  app.get('/.well-known/mcp/server-card.json', (_req, res) => res.type('application/json').send(JSON.stringify(card, null, 2) + '\n'));
  app.get('/llms.txt', (_req, res) => res.type('text/plain; charset=utf-8').send(txt));
  return { card, txt };
}
