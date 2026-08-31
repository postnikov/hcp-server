#!/usr/bin/env bash
# Деплой личного MCP: зеркалим репо в каталог на сервере, пересобираем контейнер.
#
# Куда деплоить — не в этом файле. Адрес сервера, домен и имена docker-сущностей
# лежат в context/deploy.env (личный слой, в git не едет); шаблон — context.example/deploy.env.
#
# Гейт на --delete и проверка .env — по образцу team2team/deploy.sh: там ad-hoc rsync
# без excludes однажды снёс боевой .env и уронил сервис. Список файлов — один и в коде.
set -eo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${CONTEXT_DIR:-$SRC_DIR/context}/deploy.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "✗ Нет $ENV_FILE — деплою некуда." >&2
  echo "  cp context.example/deploy.env context/deploy.env и впиши свой сервер." >&2
  exit 1
fi
set -a; . "$ENV_FILE"; set +a

: "${DEPLOY_SERVER:?в deploy.env нет DEPLOY_SERVER}"
: "${DEPLOY_DIR:?в deploy.env нет DEPLOY_DIR}"
: "${MCP_PUBLIC_URL:?в deploy.env нет MCP_PUBLIC_URL}"

# Живёт на проде и/или локально, но пересекать границу не должно:
#   .env*   — боевые секреты (ANTHROPIC_API_KEY, NOTIFY_*). Правятся на сервере.
#   data/   — журнал, инбокс и счётчик бюджета. Прод держит их в docker-volume;
#             локальная копия рядом только путает.
# context/ НЕ исключён намеренно: файлы человека и его конфиг — это и есть содержимое сервера.
RSYNC_EXCLUDES=(
  --exclude='.env*'
  --exclude='*.bak' --exclude='*.bak-*' --exclude='*.save'
  --exclude='data/'
  --exclude='node_modules/'
  --exclude='.git/'
  --exclude='scratchpad/'
)

echo "→ Тесты перед заливкой..."
cd "$SRC_DIR" && npm test

# Гейт: --delete — единственный необратимый шаг. Сначала показываем, что исчезнет.
# -v обязателен: без него rsync не печатает строки 'deleting ...' и гейт слепнет.
echo "→ Превью удалений на проде (dry-run, ничего не меняется)..."
DELETIONS=$(rsync -avzn --delete "${RSYNC_EXCLUDES[@]}" "$SRC_DIR/" "$DEPLOY_SERVER:$DEPLOY_DIR/" | grep '^deleting ' || true)
if [ -n "$DELETIONS" ]; then
  echo "⚠️  rsync УДАЛИТ на проде $(printf '%s\n' "$DELETIONS" | grep -c .) файл(ов):" >&2
  printf '%s\n' "$DELETIONS" | sed 's/^deleting /   - /' >&2
  if [ -t 0 ]; then
    read -r -p "Удалять это на проде? [y/N] " ANS
    [ "$ANS" = "y" ] || [ "$ANS" = "Y" ] || { echo "Отменено — ничего не задеплоено." >&2; exit 1; }
  elif [ "${DEPLOY_ALLOW_DELETE:-}" != "1" ]; then
    echo "Неинтерактивный запуск: перезапусти с DEPLOY_ALLOW_DELETE=1, если удаления ожидаемы." >&2
    exit 1
  fi
fi

echo "→ Заливка файлов..."
rsync -avz --delete "${RSYNC_EXCLUDES[@]}" "$SRC_DIR/" "$DEPLOY_SERVER:$DEPLOY_DIR/"

# Контекст — единственное, без чего сервер не поднимется вовсе.
echo "→ Проверка контекста на проде..."
ssh "$DEPLOY_SERVER" "ls $DEPLOY_DIR/context/*.md >/dev/null 2>&1" || {
  echo "✗ На проде нет ни одного context/*.md — сервер не стартует." >&2
  exit 1
}

# .env на проде не обязателен (без ключа ask отказывает, без NOTIFY_* уведомление
# скипается), но молча выкатить сервер без консьержа и без нотификаций — не то, чего ждут.
echo "→ Проверка боевого .env..."
ssh "$DEPLOY_SERVER" "test -s $DEPLOY_DIR/.env" || {
  echo "⚠️  $DEPLOY_DIR/.env отсутствует или пуст: ask будет отказывать, уведомления не пойдут." >&2
  echo "   Сервер поднимется и файловые тулзы будут работать. Продолжаю." >&2
}

# deploy.env грузим в окружение ssh-сессии: домен и имена нужны compose для интерполяции
# лейблов. Боевой .env при этом не трогаем — он остаётся источником одних лишь секретов.
echo "→ Пересборка контейнера..."
ssh "$DEPLOY_SERVER" "cd $DEPLOY_DIR && set -a && . ./context/deploy.env && set +a && docker compose up -d --build"

echo "→ Смоук..."
for i in $(seq 1 15); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$MCP_PUBLIC_URL" || echo 000)
  [ "$CODE" = "200" ] && { echo "✓ $MCP_PUBLIC_URL → 200"; exit 0; }
  sleep 2
done
echo "✗ $MCP_PUBLIC_URL не отвечает 200 (последний код: $CODE)" >&2
ssh "$DEPLOY_SERVER" "docker logs ${MCP_CONTAINER_NAME:-hcp-mcp} --tail 30"
exit 1
