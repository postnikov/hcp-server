/**
 * express-обвязка вокруг MCP: сборка личного слоя (конфиг + контекст), разбор IP из-за
 * прокси, ведёрки rate-limit, discovery и запуск.
 *
 * Всё остальное — в mcp.js (протокол), context.js (файлы человека), config.js (кто он),
 * lib.js (состояние, бюджет, входящие), discovery.js (карточка и llms.txt).
 */

import express from 'express';
import { fileURLToPath } from 'node:url';
import { mountMcp } from './mcp.js';
import { mountDiscovery } from './discovery.js';
import { loadConfig, contextDir, secrets as loadSecrets } from './config.js';
import { loadContext } from './context.js';
import { DATA_DIR } from './lib.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function clientIp(req) {
  // Сервер обычно стоит за прокси и портом наружу не публикуется — ходят только через него,
  // поэтому X-Forwarded-For тут и есть настоящий адрес клиента.
  return (
    String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

/**
 * @param deps.fetchImpl — исходящие запросы (Anthropic, Telegram, Resend). В тестах
 *   подменяется: ни один тест не должен уметь выйти в сеть.
 * @param deps.dir — каталог личного слоя. Тесты подсовывают сюда фикстуру.
 */
export function createApp({ fetchImpl = fetch, dir = contextDir(), env = process.env, config, context } = {}) {
  config ??= loadConfig({ dir, env });
  context ??= loadContext({ dir, groups: config.context.groups });
  const secrets = loadSecrets(env);

  const app = express();
  app.disable('x-powered-by');

  /** Ведро на вид вызова: свой лимит и своё окно у каждого. Ключ ведра — IP. */
  const buckets = {
    rpc: { max: config.limits.callsPerMinute, windowMs: MINUTE },
    ask: { max: config.limits.askPerDayPerIp, windowMs: DAY },
    leave_message: { max: config.limits.messagesPerDayPerIp, windowMs: DAY },
  };

  // ponytail: скользящее окно в памяти процесса. Один инстанс — одна карта;
  // появятся реплики — понадобится общий счётчик (бюджет-кап `ask` при этом уже на диске).
  const hits = new Map();
  const limited = (kind, ip) => {
    const { max, windowMs } = buckets[kind];
    const key = `${kind}:${ip}`;
    const now = Date.now();
    const fresh = (hits.get(key) || []).filter((at) => now - at < windowMs);
    fresh.push(now);
    hits.set(key, fresh);
    if (hits.size > 5000) hits.clear(); // грубая защита от роста карты
    return fresh.length > max;
  };

  // Тело MCP-запроса небольшое: письмо ≤2000 символов, вопрос — строка.
  const json = express.json({ limit: '64kb' });

  const mounted = mountMcp(app, { clientIp, limited, json, fetchImpl, config, context, secrets });

  if (config.discovery.enabled) {
    mountDiscovery(app, { config, tools: mounted.tools, readTools: mounted.readTools });
  }

  // Человек, зашедший браузером, должен понять, куда он попал, — и это же смоук деплоя.
  app.get('/', (_req, res) =>
    res
      .type('text/plain')
      .send(
        `${config.person.name} — personal MCP server.\n\nclaude mcp add --transport http ${config.server.connectAs} ${config.server.url}\n`,
      ),
  );

  app.locals.mcp = { config, context, ...mounted };
  return app;
}

// Запуск только при прямом вызове: тест импортирует createApp и слушает свой порт.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  let app;
  try {
    app = createApp();
  } catch (e) {
    // Нет контекста — сервер не поднимается молча пустым: агент должен получить содержание.
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
  const { config, tools } = app.locals.mcp;
  app.listen(port, () =>
    console.log(
      `${config.server.id} MCP on :${port} · ${tools.length} tools (${tools.map((t) => t.name).join(', ')}) · context: ${app.locals.mcp.context.dir} · data: ${DATA_DIR()}`,
    ),
  );
}
