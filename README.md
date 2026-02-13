# justgpt-control-plane

MVP control-plane (app + api) для managed проектов `mcp-service`.

Сейчас это минимальный UI:
- создать проект (метаданные: id/type/path/tokenEnv)
- показать endpoint и tokenEnv
- автодеплой пока выключен (следующий шаг)

## Запуск локально

```bash
npm install
npm run dev
```

Открой: `http://127.0.0.1:3000/`

## ENV

- `PORT` (default: 3000)
- `HOST` (default: 0.0.0.0)
- `DATA_FILE` (default: data/projects.json)
- `MCP_BASE_URL` (default: https://mcp.justgpt.ru)

## Деплой на VM (nginx reverse proxy)

Пример: поднять контейнер локально на VM и проксировать домены `app.justgpt.ru` и `api.justgpt.ru` на `127.0.0.1:19100`.

На VM:
```bash
git pull
docker compose up -d --build
```

Nginx (идея):
- `app.justgpt.ru` -> proxy -> `http://127.0.0.1:19100/`
- `api.justgpt.ru` -> proxy -> `http://127.0.0.1:19100/api/...`
