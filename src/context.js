/**
 * Контекст — единственный источник знаний сервера: markdown-файлы в `context/`.
 *
 * Здесь одно правило, из которого следует всё остальное: **сервер объявляет только те
 * тулзы, под которые есть файлы**. Нет `speaking.md` — нет и `get_speaking` в `tools/list`;
 * агент не получает пустой ответ на тулзу, которой у этого человека нет. Минимум для
 * запуска — один файл (`who.md`). Ноль файлов — ошибка при старте, а не пустой сервер.
 *
 * Файл может нести YAML-шапку — она не уезжает наружу и нужна ровно для двух вещей:
 * назвать тулзу (`tool:`) и объяснить её чужому агенту (`for_agent:`). Шапки нет —
 * работает конвенция из `context.groups` конфига, а дальше `get_<имя файла>`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Ключи шапки, которые сервер понимает. Остальные — заметки человека, их не трогаем. */
const META_KEYS = ['tool', 'title', 'for_agent'];

/**
 * Мини-разбор YAML-шапки: `key: value`, плюс блочные скаляры `>` и `|`.
 * Полноценный YAML тут не нужен — шапка описывает две строки, а зависимостей у репо нет.
 */
export function parseFrontmatter(raw) {
  if (!raw.startsWith('---\n')) return { meta: {}, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { meta: {}, body: raw };

  const head = raw.slice(4, end + 1).split('\n');
  const body = raw.slice(raw.indexOf('\n', end + 1) + 1);
  const meta = {};

  for (let i = 0; i < head.length; i++) {
    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(head[i]);
    if (!match) continue;
    const [, key, inline] = match;

    if (inline === '>' || inline === '|' || inline === '>-' || inline === '|-') {
      // Блок — всё, что дальше с отступом. Свёрнутый (`>`) склеивается пробелами.
      const lines = [];
      while (i + 1 < head.length && (head[i + 1].trim() === '' || /^\s+/.test(head[i + 1]))) {
        lines.push(head[++i].replace(/^\s{1,4}/, ''));
      }
      const text = inline.startsWith('>') ? lines.join(' ').replace(/\s+/g, ' ') : lines.join('\n');
      meta[key] = text.trim();
    } else {
      meta[key] = inline.trim().replace(/^["'](.*)["']$/, '$1');
    }
  }
  return { meta, body };
}

/** Заголовок секции: из шапки, иначе из первого `# ` файла, иначе имя файла. */
const titleOf = (meta, body, slug) => meta.title || /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || slug;

/**
 * Читает каталог контекста и раскладывает его на тулзы.
 *
 * @param dir каталог с `*.md`
 * @param groups карта «тулза → файлы» из конфига: задаёт и склейку, и порядок тулз
 * @returns {{sections: object, tools: Array, asPrompt: function, section: function}}
 */
export function loadContext({ dir, groups = {} }) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    throw new Error(
      `No context directory at ${dir}. A personal MCP server has nothing to serve without one: copy context.example/ to context/ and fill in who.md.`,
    );
  }

  const files = names
    .filter((name) => name.endsWith('.md') && !name.startsWith('_') && name.toLowerCase() !== 'readme.md')
    .sort();

  const sections = {};
  for (const name of files) {
    const slug = name.slice(0, -3);
    const { meta, body } = parseFrontmatter(readFileSync(join(dir, name), 'utf8'));
    // Пустой файл — не секция: агенту нечего отдавать, и объявлять тулзу не за что.
    if (!body.trim()) continue;
    // Тело уходит агенту байт в байт, как человек его написал: шапка снята, больше ничего.
    sections[slug] = {
      slug,
      title: titleOf(meta, body, slug),
      forAgent: meta.for_agent || '',
      tool: meta.tool || '',
      body,
      meta: Object.fromEntries(Object.entries(meta).filter(([key]) => !META_KEYS.includes(key))),
    };
  }

  if (!Object.keys(sections).length) {
    throw new Error(
      `No context files in ${dir}. A personal MCP server needs at least one — start with who.md (see context.example/).`,
    );
  }

  // --- раскладка по тулзам ---------------------------------------------------
  // Шапка файла сильнее конвенции конфига, конвенция сильнее имени файла.
  const byGroup = {};
  for (const [tool, slugs] of Object.entries(groups)) for (const slug of slugs) byGroup[slug] = tool;
  for (const section of Object.values(sections)) section.tool ||= byGroup[section.slug] || `get_${section.slug}`;

  const order = (tool) => {
    const index = Object.keys(groups).indexOf(tool);
    return index === -1 ? Object.keys(groups).length : index;
  };
  const slugOrder = (tool, slug) => {
    const index = (groups[tool] || []).indexOf(slug);
    return index === -1 ? (groups[tool] || []).length : index;
  };

  const tools = [];
  for (const section of Object.values(sections)) {
    const found = tools.find((tool) => tool.name === section.tool);
    if (found) found.slugs.push(section.slug);
    else tools.push({ name: section.tool, slugs: [section.slug] });
  }
  for (const tool of tools) tool.slugs.sort((a, b) => slugOrder(tool.name, a) - slugOrder(tool.name, b));
  // Порядок тулз — тот, в котором человек перечислил их в конфиге; остальные следом, по алфавиту.
  tools.sort((a, b) => order(a.name) - order(b.name) || a.name.localeCompare(b.name));

  for (const tool of tools) {
    const first = sections[tool.slugs[0]];
    const titles = tool.slugs.map((slug) => sections[slug].title);
    tool.title = first.title;
    // Описание — авторское из шапки; его нет — честный однострочник вместо выдумки.
    tool.description =
      tool.slugs.map((slug) => sections[slug].forAgent).find(Boolean) ||
      `Returns, as Markdown and verbatim, the hand-maintained context file${tool.slugs.length > 1 ? 's' : ''}: ${titles.join(' · ')}. Free, instant and always in sync with what the human wrote.`;
  }

  /** Склейка секций тулзы — то, что видит агент. Разделитель тот же, что был у пака. */
  const render = (slugs) => slugs.map((slug) => sections[slug].body).join('\n\n---\n\n');

  return {
    dir,
    sections,
    tools,
    render,
    /** Весь контекст одним текстом — системный промпт `ask` и ничего больше. */
    asPrompt: () =>
      tools
        .flatMap((tool) => tool.slugs)
        .map((slug) => `<file name="${slug}.md">\n${sections[slug].body}\n</file>`)
        .join('\n\n'),
  };
}
