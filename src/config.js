/**
 * Конфигурация сервера — всё, что отличает одного человека от другого.
 *
 * Код здесь обезличен: ни имени, ни домена, ни ключей. Личное живёт в двух местах,
 * и оба вне git: `context/config.json` (кто ты, как зовут сервер, какие капы) и
 * переменные окружения (секреты и ручки деплоя). Env всегда сильнее файла.
 *
 * Форкнул репо — правишь только `context/`. Код остаётся общим для всех.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Каталог личного слоя. Один env двигает и файлы контекста, и конфиг: они всегда рядом. */
export const contextDir = (env = process.env) => {
  const dir = env.CONTEXT_DIR || 'context';
  return isAbsolute(dir) ? dir : join(ROOT, dir);
};

/**
 * Дефолты — рабочий безымянный сервер. Он поднимется и без `context/config.json`:
 * отдаст файлы контекста и примет письмо. Всё остальное человек включает сам.
 */
export const DEFAULTS = {
  person: {
    // Пусто = «человек ещё не представился»: сервер поднимется, но скажет об этом честно.
    name: '',
    short: '',
    headline: '',
    site: '',
    // Местоимения нужны ровно в двух фразах ответов агенту. Дефолт — нейтральный.
    pronouns: { subject: 'they', object: 'them', possessive: 'their' },
  },
  server: {
    // serverInfo.name в handshake; connectAs — имя в примере `claude mcp add`.
    id: 'hcp',
    connectAs: '',
    version: '1.0.0',
    url: '',
    // Пусто — instructions собираются из person + состава тулз (см. mcp.js).
    instructions: '',
  },
  context: {
    /**
     * Какие файлы контекста в какую тулзу склеиваются и в каком порядке идут тулзы.
     * Файл, не названный здесь, всё равно поедет наружу — своей тулзой `get_<имя файла>`.
     * Ключ без единого существующего файла тулзу не создаёт: сервер объявляет то, что есть.
     */
    groups: {
      get_profile: ['who', 'now'],
      get_speaking: ['speaking'],
      get_services: ['services'],
      get_channels: ['channels'],
      get_writing: ['writing'],
    },
  },
  /** Переопределение описаний `ask` и `leave_message`: они говорят о человеке, а не о коде. */
  tools: {},
  /**
   * Документы, которые сервер читает по URL и отдаёт агенту, — например схемы, которые
   * человек публикует у себя на сайте. Ключ = имя коллекции, и на каждую заводятся две
   * тулзы: список и текст по slug. Пусто — тулз документов нет вовсе.
   *
   *   "documents": {
   *     "blueprints": {
   *       "index": "https://example.com/downloads/blueprints.json",
   *       "ttlMinutes": 60,
   *       "list_tool": "list_blueprints",
   *       "get_tool": "get_blueprint"
   *     }
   *   }
   *
   * Смысл — не заводить вторую копию текстов: правда живёт там, где человек публикует,
   * а сервер её читает. Формат манифеста — `{documents: [{slug, title, summary, url, updated}]}`
   * (голый массив тоже принимается).
   */
  documents: {},
  ask: {
    // В шаблоне выключено намеренно: `ask` — единственная тулза, которая стоит денег.
    enabled: false,
    model: 'claude-sonnet-5-5',
    maxTokens: 1024,
    // Без мышления до ответа: при max_tokens ≈1k адаптивное мышление съело бы весь ответ,
    // а консьерж пересказывает готовый контекст. Sonnet 5.5 отвечает 400 на `disabled` —
    // тот же режим у него зовётся `between_tools`; другая модель — другое значение здесь.
    thinking: { type: 'between_tools' },
    callsPerDay: 20,
    tokensPerDay: 150_000,
  },
  limits: { callsPerMinute: 60, askPerDayPerIp: 10, messagesPerDayPerIp: 5 },
  /** Свои `/.well-known/mcp/server-card.json` и `/llms.txt`. Выключи, если их отдаёт сайт. */
  discovery: { enabled: true },
};

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Слияние в глубину: файл переопределяет ветку, не стирая соседние ключи дефолтов. */
function merge(base, patch) {
  if (!isPlain(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    // undefined = «не задано»: env-оверрайд без значения не должен затирать дефолт.
    if (value === undefined) continue;
    out[key] = isPlain(base?.[key]) ? merge(base[key], value) : value;
  }
  return out;
}

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};
const num = (value, fallback) => (value === undefined || value === '' || Number.isNaN(Number(value)) ? fallback : Number(value));

/**
 * Env поверх файла. Здесь только то, что меняется от машины к машине или от деплоя
 * к деплою: секреты, флаги и публичный адрес. Всё остальное — в `context/config.json`.
 */
function fromEnv(config, env) {
  const out = merge(config, {
    person: { name: env.MCP_PERSON_NAME || undefined, site: env.MCP_SITE || undefined },
    server: { url: env.MCP_PUBLIC_URL || undefined },
    ask: {
      enabled: bool(env.ASK_ENABLED, config.ask.enabled),
      model: env.ASK_MODEL || undefined,
      maxTokens: num(env.ASK_MAX_TOKENS, config.ask.maxTokens),
      callsPerDay: num(env.ASK_CALLS_PER_DAY, config.ask.callsPerDay),
      tokensPerDay: num(env.ASK_TOKENS_PER_DAY, config.ask.tokensPerDay),
    },
    discovery: { enabled: bool(env.SERVE_DISCOVERY, config.discovery.enabled) },
  });
  return out;
}

/** Секреты не едут в конфиг-объект: их читают там, где вызывают, — по одному имени на канал. */
export const secrets = (env = process.env) => ({
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  // TG_* без префикса — совместимость с серверами, поднятыми до переименования.
  tgToken: env.NOTIFY_TG_BOT_TOKEN || env.TG_BOT_TOKEN || '',
  tgChat: env.NOTIFY_TG_CHAT_ID || env.TG_CHAT_ID || '',
  resendKey: env.NOTIFY_RESEND_API_KEY || '',
  emailTo: env.NOTIFY_EMAIL_TO || '',
  emailFrom: env.NOTIFY_EMAIL_FROM || '',
});

/**
 * Собранный конфиг. Файла нет — работают дефолты: это не ошибка, а lite-режим.
 * Битый JSON — ошибка громкая: тихо подставить дефолты значило бы поднять чужой сервер.
 */
export function loadConfig({ dir = contextDir(), env = process.env } = {}) {
  let file = {};
  try {
    file = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`Broken ${join(dir, 'config.json')}: ${e.message}`);
  }

  const config = fromEnv(merge(DEFAULTS, file), env);
  // Короткое имя и имя для `claude mcp add` выводятся из полного, пока не заданы явно.
  config.person.short ||= config.person.name.split(' ')[0] || 'the owner of this server';
  config.person.name ||= config.person.short;
  config.server.connectAs ||= config.server.id;
  return config;
}
