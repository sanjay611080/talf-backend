# Talf Solar MIS — Backend

Node.js + TypeScript + Express API that backs the `talf-solar-MIS-Prototype`
frontend. Replaces the frontend's `localStorage` / mock-service layer with real
HTTP endpoints, JWT auth, and a JSON-file datastore.

## Run

```bash
npm install
npm run dev      # http://localhost:4000  (tsx watch)
```

`npm run build` compiles to `dist/`, `npm start` runs the compiled server.

On first start it seeds `data/db.json` with the same demo projects, module
builds, and users the prototype used.

## Seeded logins

| username | password   | role       |
|----------|------------|------------|
| admin    | password   | admin      |
| ops      | password   | operations |
| viewer   | password   | viewer     |

## API

All routes are under `/api`. Every route except `/auth/login` and `/health`
requires an `Authorization: Bearer <token>` header.

| Method | Path                                           | Role             |
|--------|------------------------------------------------|------------------|
| GET    | `/health`                                      | public           |
| POST   | `/auth/login`                                  | public           |
| GET    | `/auth/me`                                     | any              |
| GET    | `/projects`                                    | any              |
| GET    | `/projects/:code`                              | any              |
| PUT    | `/projects`  (bulk replace)                    | admin, operations|
| POST   | `/projects`                                    | admin            |
| PUT    | `/projects/:code`                              | admin, operations|
| DELETE | `/projects/:code`                              | admin            |
| GET    | `/module-builds`                               | any              |
| POST   | `/module-builds`                               | admin, operations|
| PUT    | `/module-builds/:id`                           | admin, operations|
| DELETE | `/module-builds/:id`                           | admin, operations|
| GET    | `/kpis/portfolio?range=`                       | any              |
| GET    | `/kpis/projects/:code?range=`                  | any              |
| GET    | `/kpis/projects/:code/inverters/:index?range=` | any              |
| GET    | `/solis/credentials`                           | admin            |
| PUT    | `/solis/credentials`                           | admin            |
| GET    | `/solis/test`                                  | admin, operations|
| GET    | `/solis/stations`                              | any              |
| GET    | `/solis/stations/:id/inverters`                | any              |
| GET    | `/solis/inverters/:sn/realtime`                | any              |
| GET    | `/solis/inverters/:sn/day?date=&timeZone=`     | any              |
| POST   | `/solis/projects/:code/sync?month=`            | admin, operations|
| GET    | `/solis/sync/status`                           | any              |
| POST   | `/solis/sync`                                  | admin, operations|

`range` is `6M`, `12M`, or `ALL` (default).

## SolisCloud integration

The backend is the SolisCloud API client — it holds the API ID/Secret and signs
every request (HMAC-SHA1 over `POST\n{MD5}\n{ContentType}\n{Date}\n{path}`), so
the secret never reaches the browser. **All SolisCloud calls are read-only**
(`userStationList`, `inverterList`, `inverterDetail`, `inverterDay`,
`inverterYear`) — the integration never writes to SolisCloud.

### Setup

Put your credentials in `.env`:

```
SOLIS_API_ID=your-api-id
SOLIS_API_SECRET=your-api-secret
```

On startup (and via `POST /solis/sync`) the backend **fetches your whole
SolisCloud account**: every station becomes a project, every inverter becomes
an inverter, and monthly generation is pulled across the full history with
`inverterYear`. Calls are throttled to respect SolisCloud's 2 req/sec limit, so
the first sync runs in the background — poll `GET /solis/sync/status`.

`.env` credentials take precedence over anything saved through the Settings UI.

### How real data maps to KPIs

The KPI engine (`src/services/kpiService.ts`, the same logic as the frontend)
runs on the fetched data:

- **Generation / net energy / revenue / CO₂ / AC CUF** — fully real, from
  SolisCloud generation and the station's tariff.
- **Grid import** — real, from each inverter's `gridPurchasedEnergy`.
- **DC CUF / yield** — uses the inverter's AC nameplate as the DC capacity
  unless a module build is assigned in the app (SolisCloud has no module data).
- **PR** — needs plane-of-array irradiation, which SolisCloud does not provide;
  it stays 0 until irradiation is entered manually.

## Config

Copy `.env.example` to `.env`. Beyond `PORT` / `JWT_SECRET`, it controls the
SolisCloud credentials and `SOLIS_AUTO_SYNC` / `SOLIS_SYNC_TTL_HOURS`. Data
lives in `data/db.json` — delete it to re-seed the demo data.

## Notes

- Datastore is an in-memory object flushed to `data/db.json` on every write.
  Swap `src/db/store.ts` for a real database (e.g. PostgreSQL) without touching
  the routes.
- A successful sync replaces the demo projects with your real SolisCloud
  stations. User-entered fields (module-build assignments, manual targets /
  irradiation, tariff edits) are preserved across re-syncs.
