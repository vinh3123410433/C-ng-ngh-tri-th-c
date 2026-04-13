# Requirements Knowledge Base

A runnable web system to collect, normalize, analyze, and trace software requirements.

## Implemented scope

- Requirements collection for FR and NFR
- Template normalization: Actor - Action - Object - Constraint
- Auto parsing from description or manual field input
- Relationship model with types:
  - depends_on
  - conflicts_with
  - duplicates
- Conflict detection rule engine loaded from JSON rules file
- Traceability links:
  - Requirement -> Test case
  - Requirement -> Design
  - Requirement -> Code
- Dashboard with KPIs and charts
- Relationship graph visualization
- Filters by type and priority
- REST APIs for integration

## Tech stack (adapted to current environment)

- Backend: Flask + SQLite
- Frontend: HTML + Tailwind CDN + vanilla JS
- Graph visualization: vis-network
- Charts: Chart.js

## Project structure

- server/app.py: Flask app, API routes, rules engine, DB schema
- server/templates/index.html: Main UI
- server/static/js/app.js: Frontend logic
- server/data/rules.json: Conflict/duplicate rules
- server/requirements.txt: Python dependency list

## Run locally

1. Install dependency:

```powershell
C:/Users/vinh/AppData/Local/Programs/Python/Python311/python.exe -m pip install -r server/requirements.txt
```

2. Start server:

```powershell
Set-Location "d:/Công nghệ tri thức/server"
C:/Users/vinh/AppData/Local/Programs/Python/Python311/python.exe app.py
```

3. Open app:

- http://127.0.0.1:5000

## Main APIs

- POST /api/requirements
- GET /api/requirements
- PUT /api/requirements/:id
- DELETE /api/requirements/:id
- POST /api/relationships
- GET /api/requirements/:id/related
- POST /api/traceability
- GET /api/traceability/:id
- GET /api/conflicts
- GET /api/dashboard
- GET /api/graph

## Notes

- Conflict detection currently includes:
  - opposite action on same actor + object
  - incompatible constraints, such as < 2s versus > 5s
- Derived relationships (conflicts_with, duplicates) are recalculated automatically after requirement updates.
