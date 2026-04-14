# Solar Typical-Year Budget Model (Node.js + React)

A local app to model one full year of home solar economics in 30-minute slots using PVGIS generation data.

## What it models

- PVGIS-based generation per array (multi-array support: tilt/azimuth/loss per array)
- Inverter parameters (AC power limit, efficiency, idle consumption)
- Battery storage with:
  - capacity, usable %, min SOC, target SOC, initial SOC
  - max charge/discharge rate
  - force-charge windows (grid charging + target SOC)
  - force-discharge windows
- Export limit (DNO cap)
- Typical day demand input (48 half-hour slots) + monthly adjustment multipliers
- Tariffs with 30-minute slot pricing:
  - import (48 slots)
  - export (48 slots)
  - standing charge/day
- Octopus import support:
  - `.env` account + API key
  - dropdown of available account tariffs
  - one-click tariff import from Octopus rates
  - import typical daily usage profile (48 slots) from Octopus consumption data
- Home Assistant CSV import:
  - import a typical-day power trace
  - populates 48-slot consumption and minute-level shape
  - simulation dispatch uses minute sub-steps when minute shape exists
- Compare one tariff or multiple tariffs in one run
- Yearly financial outputs + monthly breakdown
- File-based storage (`server/src/data/project.json`), no DB

## Extra financial factors included

- Import VAT
- Export tax factor
- Annual maintenance cost
- Battery degradation cost per kWh throughput
- Estimated grid CO2 emissions
- Curtailment tracking
- Autarky and self-consumption metrics

## Architecture

- `server/`: Express API + simulation engine
- `client/`: React (Vite) UI
- Root npm workspaces to run both

## Run

```bash
npm install
npm run dev
```

- Frontend: `http://localhost:5173`
- API: `http://localhost:3001`

## Octopus `.env` setup

Create `.env` in repo root (or copy `.env.example`):

```bash
OCTOPUS_ACCOUNT_NUMBER=A-12345678
OCTOPUS_API_KEY=your_octopus_api_key_here
```

Then in the Tariffs section:
1. Click `Load Tariffs From .env`
2. Pick import/export tariff from dropdown
3. Set `Import VAT-inclusive rates` on/off
4. Click `Import Tariff`

Typical consumption import:
1. In `Consumption + Economics`, set `Usage import days`
2. Click `Import Usage From Octopus`
3. The 48-slot box is populated and can be edited manually

Notes:
- Octopus API returns tariff values in pence; importer converts to GBP for this model.
- If `Period From/To` is left empty, import uses the last 24 hours (slot profile is averaged over selected period).
- Octopus tariff slot mapping is normalized to UK clock time (`Europe/London`), so windows like `00:30-05:30` stay in those slots across DST changes.

## API

- `GET /api/project` -> load current project JSON
- `POST /api/project` -> save project JSON
- `POST /api/simulate` -> run simulation
  - body: `{ "project": { ... }, "tariffIds": ["id1", "id2"] }`
- `GET /api/octopus/available-tariffs` -> list available tariffs for `.env` account
- `POST /api/import-octopus-tariff` -> import Octopus tariff as app tariff object
- `POST /api/octopus/import-usage-profile` -> build 48-slot typical daily usage profile from Octopus consumption data
- `POST /api/import-homeassistant-csv` -> parse Home Assistant CSV into `slotKwh` + `minuteShapeKw`

## Data assumptions

- Simulation uses 30-minute slots for year `2025`
- PV generation uses PVGIS `seriescalc` hourly output for `2020` as a typical-year proxy
- Hourly PV output is split into two half-hour slots

## Main files

- `server/src/services/simulate.js`
- `server/src/services/pvgis.js`
- `server/src/routes/projectRoutes.js`
- `client/src/App.jsx`
