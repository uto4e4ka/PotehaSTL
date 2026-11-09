# PotehaSTL bot

Telegram bot and HTTP API in one process, Python standard library only (no dependencies).

- In the bot: `/start` gives the free tokens and a personal key, `/balance`, `/buy` (tokens for Telegram Stars), `/key`, `/newkey`, `/history`, `/paysupport`. Admins (`ADMIN_IDS`) can use `/give <tg_id> <n>` and `/refund <charge_id>`.
- API for the extension: `GET /api/balance`, `POST /api/spend {format, host}` reserves tokens, `POST /api/finish {spend_id, ok}` confirms them or returns them if the export failed.

## Running

```
BOT_TOKEN=123:abc python bot.py
```

Variables: `BOT_TOKEN`, `PORT` (8080), `DB_PATH`, `FREE_TOKENS` (5), `COST_GLB` (1), `COST_STL` (1), `PACKS` ("50:25,200:90,1000:400", meaning tokens:stars), `ADMIN_IDS`.

On Railway: deploy the `bot/` folder (there is a Dockerfile), set `BOT_TOKEN`, attach a volume at `/data` and generate a domain. Put that domain into `extension/config.js` as `SERVER_URL`.
