# QuickDesk — Microservices-Based Support Ticket System

A backend for an IT / customer support desk, built as small **Node.js + Express** microservices.
Users raise tickets, an admin assigns them to agents, and agents move them through a status workflow.

- **Auth Service** — registration, login, JWT, roles. Data in **PostgreSQL**.
- **Ticket Service** — tickets, assignment, comments, status history, filters, stats. Data in **MongoDB**.
- **API Gateway** — the single public entry point; routes requests to the services.
- **Docker Compose** to run everything with one command, deployable on **AWS EC2** (see [DEPLOY_AWS.md](DEPLOY_AWS.md)).

## Architecture

```mermaid
flowchart LR
    C[Client / Postman] -->|:8080| G[API Gateway]
    G -->|/auth/*| A[Auth Service :4001]
    G -->|/tickets/*| T[Ticket Service :4002]
    A --> P[(PostgreSQL)]
    T --> M[(MongoDB)]
    T -. "REST: GET /internal/users/:id\n(validate assignee)" .-> A
```

Only the gateway publishes a port. The services and both databases live on the private Docker network.

**Why two databases?** Each service owns its data (database-per-service).
Users are relational and need a unique email constraint, so they live in PostgreSQL.
Tickets are document-shaped (embedded comments and status history) and are filtered in many ways, so they live in MongoDB.

**How auth works across services:** `auth-service` signs a JWT (HS256) at login. `ticket-service` verifies that token
locally with the shared `JWT_SECRET`, so it does not call `auth-service` on every request.
The only service-to-service call is when an admin assigns a ticket: `ticket-service` asks `auth-service`
(`/internal/users/:id`, protected by `INTERNAL_API_KEY` and not exposed by the gateway) whether the assignee exists and is an agent.

## Quick start (Docker)

```bash
cp .env.example .env        # then edit the secrets
docker compose up --build   # first run takes a few minutes
```

The API is now at **http://localhost:8080**. In another terminal run the end-to-end check:

```bash
node scripts/smoke-test.js http://localhost:8080
```

A default admin is created on first start from `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env`
(defaults: `admin@quickdesk.local` / `Admin@12345`).

## Run without Docker (development)

Requires Node 18+, a local PostgreSQL and a local MongoDB.

```bash
# terminal 1
cd auth-service && npm install
DATABASE_URL=postgres://USER:PASS@localhost:5432/quickdesk_auth JWT_SECRET=dev INTERNAL_API_KEY=dev \
ADMIN_EMAIL=admin@quickdesk.local ADMIN_PASSWORD='Admin@12345' npm run dev

# terminal 2
cd ticket-service && npm install
MONGO_URI=mongodb://localhost:27017/quickdesk_tickets JWT_SECRET=dev INTERNAL_API_KEY=dev \
AUTH_SERVICE_URL=http://localhost:4001 npm run dev

# terminal 3
cd gateway && npm install
AUTH_SERVICE_URL=http://localhost:4001 TICKET_SERVICE_URL=http://localhost:4002 npm run dev
```

## Roles & permissions

| Action | User | Agent | Admin |
|---|:--:|:--:|:--:|
| Register / login | ✅ | ✅ | ✅ |
| Create a ticket | ✅ | ✅ | ✅ |
| See tickets | own | assigned to them (+ own) | all |
| Assign / unassign a ticket | ❌ | ❌ | ✅ |
| Change status | close / re-open own | any valid transition, if assigned | any valid transition |
| Comment | on accessible tickets | on accessible tickets | on any ticket |
| Promote users to agent, list users, view stats | ❌ | ❌ | ✅ |

Status workflow: `open → in_progress → resolved → closed` (with `in_progress → open`, `resolved → in_progress`, `closed → open`).
Every change is recorded in the ticket's `statusHistory`. Closed tickets cannot receive comments.

## API reference (all via the gateway, port 8080)

### Auth Service
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/register` | – | Create an account (role `user`) |
| POST | `/auth/login` | – | Returns a JWT |
| GET | `/auth/me` | any | Current user |
| GET | `/auth/users?role=agent` | admin | List users, optional role filter |
| PATCH | `/auth/users/:id/role` | admin | Change a user's role (`user`, `agent`, `admin`) |
| GET | `/auth/health` | – | Health check |

### Ticket Service
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/tickets` | any | Create a ticket `{title, description, priority?}` |
| GET | `/tickets` | any | List with filters (below), scoped by role |
| GET | `/tickets/:id` | owner / assignee / admin | Ticket with comments and status history |
| PATCH | `/tickets/:id/assign` | admin | `{agentId}` (or `{agentId: null}` to unassign) |
| PATCH | `/tickets/:id/status` | see roles | `{status}` |
| POST | `/tickets/:id/comments` | accessible | `{text}` |
| GET | `/tickets/stats` | admin | Counts by status and priority, unassigned open tickets |
| GET | `/tickets/health` | – | Health check |

**List filters:** `status=open,in_progress` · `priority=high` · `assignedTo=unassigned|<agentId>` (admin) · `q=text` (title/description) · `page` · `limit` (max 50) · `sort=createdAt|-createdAt|updatedAt|-updatedAt`

Send the token as `Authorization: Bearer <token>`.

### Example flow

```bash
BASE=http://localhost:8080

# 1. register + login
curl -s -X POST $BASE/auth/register -H 'Content-Type: application/json' \
  -d '{"name":"Alice","email":"alice@example.com","password":"Password@123"}'
TOKEN=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"Password@123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

# 2. create a ticket
curl -s -X POST $BASE/tickets -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"Cannot log in","description":"Blank page after login","priority":"high"}'

# 3. list my open, high-priority tickets
curl -s "$BASE/tickets?status=open&priority=high" -H "Authorization: Bearer $TOKEN"
```

## Project structure

```
QuickDesk/
├── docker-compose.yml
├── .env.example
├── gateway/          # Express + http-proxy-middleware, rate limiting, CORS
├── auth-service/     # users, bcrypt, JWT, roles          -> PostgreSQL
│   └── src/{routes,middleware,utils,db.js,config.js,app.js,server.js}
├── ticket-service/   # tickets, workflow, filters, stats  -> MongoDB (Mongoose)
│   └── src/{routes,models,middleware,services,utils,...}
└── scripts/smoke-test.js
```

## Design notes and limitations

- **Passwords** are hashed with bcrypt. **Tokens** expire after 1 hour.
- **Role changes** take effect at the user's next login, because the role is stored inside the JWT. A production system would add refresh tokens or a token revocation list.
- **Not-yours tickets return 404, not 403**, so people cannot discover which ticket ids exist.
- **The shared JWT secret** means both services trust the same key. Asymmetric signing (RS256, with only `auth-service` holding the private key) would be the next hardening step.
- **Ideas for improvement:** automated tests (Jest + Supertest), email notifications through a third service or a queue, OpenAPI docs, request logging with correlation ids, HTTPS with a reverse proxy.
