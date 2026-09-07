/**
 * Документы по URL — третий источник контента рядом с `context/` и `ask`.
 *
 * Идея та же, что у файловых тулз, только файлы лежат не в репо, а на сайте человека:
 * сервер читает манифест по HTTP, кэширует его в памяти и отдаёт агенту список и тексты.
 * Так у документа остаётся ОДИН источник правды — страница, где его публикует человек, —
 * а MCP не заводит вторую копию, которая начнёт отставать в тот же день.
 *
 * Нет секции `documents` в конфиге — нет и тулз. То же правило, что «нет файла — нет тулзы».
 *
 * Сеть — единственное место в сервере, которое может лежать, поэтому поведение при отказе
 * задано явно: есть кэш — отдаём кэш и ГОВОРИМ, что он несвежий; кэша нет — честная ошибка
 * со ссылкой на источник. Молча отдать пустой список хуже, чем сказать «не смог».
 *
 * Содержимое документов — данные, а не инструкции: оно уходит агенту как текст ровно так же,
 * как markdown из `context/`, и сервером не исполняется.
 */

const MINUTE = 60_000;

/** Дефолты коллекции. `ttlMinutes` — как часто перечитывать манифест. */
const DEFAULT_TTL_MINUTES = 60;

/**
 * Потолок на размер одного документа. Ответ тулзы уезжает агенту целиком, и это
 * единственное место, где размер приходит извне процесса, — обрезаем и говорим об этом.
 */
const DEFAULT_MAX_BYTES = 512_000;

/** Имена тулз коллекции: из конфига, иначе по конвенции. */
export const toolNames = (name, spec = {}) => ({
  list: spec.list_tool || `list_${name}`,
  get: spec.get_tool || `get_${name}`,
});

/** Манифест терпим к форме: массив или `{documents: [...]}`. Запись без slug и url — не документ. */
function parseIndex(payload) {
  const raw = Array.isArray(payload) ? payload : payload?.documents;
  if (!Array.isArray(raw)) return null;
  const documents = raw
    .filter((doc) => doc && typeof doc.slug === 'string' && typeof doc.url === 'string')
    .map((doc) => ({
      slug: doc.slug,
      title: doc.title || doc.slug,
      summary: doc.summary || '',
      tag: doc.tag || '',
      lang: doc.lang || '',
      url: doc.url,
      updated: doc.updated || '',
    }));
  return {
    documents,
    generated: (Array.isArray(payload) ? '' : payload?.generated) || '',
    source: (Array.isArray(payload) ? '' : payload?.source) || '',
  };
}

/**
 * Хранилище коллекций на процесс. Состояния между запросами у сервера нет, но кэш —
 * это не состояние диалога: он одинаков для всех и переживает любой запрос.
 *
 * @param deps.fetchImpl — в тестах подменяется, наружу из тестов не уходит ничего.
 * @param deps.now — часы, чтобы TTL можно было проверить, а не ждать час.
 */
export function createDocuments({ config, fetchImpl = fetch, now = () => Date.now() }) {
  const specs = config.documents || {};
  const names = Object.keys(specs);

  /** @type {Map<string, {index: object|null, at: number, error: string, bodies: Map}>} */
  const cache = new Map(names.map((name) => [name, { index: null, at: 0, error: '', bodies: new Map() }]));

  const ttlMs = (name) => (Number(specs[name].ttlMinutes) || DEFAULT_TTL_MINUTES) * MINUTE;
  const maxBytes = (name) => Number(specs[name].maxBytes) || DEFAULT_MAX_BYTES;
  const fresh = (state, name) => state.index && now() - state.at < ttlMs(name);

  /** Один поход за манифестом. Провал не стирает прошлый успех — он только помечается. */
  async function refreshIndex(name) {
    const state = cache.get(name);
    try {
      const res = await fetchImpl(specs[name].index, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parseIndex(await res.json());
      if (!parsed) throw new Error('the index is not a list of documents');
      state.index = parsed;
      state.at = now();
      state.error = '';
      // Манифест мог поменяться — тексты, которых в нём больше нет, держать незачем.
      for (const slug of [...state.bodies.keys()]) {
        if (!parsed.documents.some((doc) => doc.slug === slug)) state.bodies.delete(slug);
      }
    } catch (e) {
      state.error = String(e?.message || e);
    }
    return state;
  }

  async function ensureIndex(name) {
    const state = cache.get(name);
    if (fresh(state, name)) return state;
    return refreshIndex(name);
  }

  /** Прогрев при старте: сервер не ждёт сети и не падает из-за неё. */
  function prime() {
    return Promise.all(names.map((name) => refreshIndex(name).catch(() => {})));
  }

  const staleOf = (state, name) => Boolean(state.index) && !fresh(state, name);

  /** Список документов коллекции. */
  async function list(name) {
    const state = await ensureIndex(name);
    if (!state.index) {
      return { ok: false, error: state.error, index: specs[name].index };
    }
    return {
      ok: true,
      stale: staleOf(state, name),
      error: state.error,
      fetchedAt: new Date(state.at).toISOString(),
      generated: state.index.generated,
      source: state.index.source || specs[name].index,
      documents: state.index.documents,
    };
  }

  /** Текст одного документа. Тело тоже кэшируется и живёт по тому же TTL, что и манифест. */
  async function get(name, slug) {
    const state = await ensureIndex(name);
    if (!state.index) return { ok: false, error: state.error, index: specs[name].index };

    const doc = state.index.documents.find((item) => item.slug === slug);
    if (!doc) return { ok: false, unknownSlug: true, slugs: state.index.documents.map((item) => item.slug) };

    const cached = state.bodies.get(slug);
    if (cached && now() - cached.at < ttlMs(name)) {
      return { ok: true, stale: staleOf(state, name), doc, text: cached.text, truncated: cached.truncated };
    }

    try {
      const res = await fetchImpl(doc.url, { headers: { accept: 'text/markdown, text/plain, */*' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let text = await res.text();
      const truncated = text.length > maxBytes(name);
      if (truncated) text = `${text.slice(0, maxBytes(name))}\n\n[...truncated at ${maxBytes(name)} characters — read the rest at ${doc.url}]`;
      state.bodies.set(slug, { text, truncated, at: now() });
      return { ok: true, stale: staleOf(state, name), doc, text, truncated };
    } catch (e) {
      // Протухший текст лучше отсутствующего: отдаём с честной пометкой.
      if (cached) return { ok: true, stale: true, doc, text: cached.text, truncated: cached.truncated };
      return { ok: false, error: String(e?.message || e), url: doc.url };
    }
  }

  return { names, specs, prime, list, get, refreshIndex };
}
