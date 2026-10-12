# My Health App — Backend Service

Modular monolith backend service for **My Health App**, built with **Node.js**, **Express**, **TypeScript (Strict Mode)**, **PostgreSQL** (Prisma ORM), and **S3-Compatible Object Storage**.

---

## 1. Prerequisites

- **Node.js:** `>=20.0.0` (Verified on Node 22 LTS)
- **Docker & Docker Compose:** For running local PostgreSQL and MinIO datastores.

---

## 2. Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Start Local Datastores (Docker Compose)
```bash
docker compose up -d
```
Starts:
- **PostgreSQL 16:** Available on `localhost:5432` (`myhealthapp_dev` database).
- **MinIO S3:** Available on `localhost:9000` (API) and `localhost:9001` (Web Console).

### 3. Run Automated Tests & Type Checking
```bash
npm test
npm run typecheck
```
*Current test suite: 25 passing unit, integration, and benchmark tests (0 failures).*

### 4. Start Development Server
```bash
npm run dev
```
Listens on `http://localhost:4000`. Health check endpoint: `GET http://localhost:4000/healthz`.

---

## 3. Architecture & Directory Layout

```
myhealthapp-backend/
├── src/
│   ├── app.ts                 # Express app factory with Helmet, CORS, and routers
│   ├── index.ts               # Server bootstrap entry point
│   ├── config/                # Validated environment configuration (Zod)
│   ├── middleware/
│   │   ├── auth.ts            # Server-side identity resolution & ownership enforcement
│   │   └── errorHandler.ts    # Sanitized error handler preventing PHI leaks
│   └── modules/
│       ├── auth/              # AuthProviderAdapter interface & mock adapter
│       ├── storage/           # S3/MinIO storage provider, magic byte verification, 15m TTL URLs
│       ├── documents/         # Document metadata, upload intents, preview signed URLs
│       ├── prescriptions/     # Zod domain schemas, review confirmation, timeline ingestion
│       └── ai-extraction/     # Provider abstraction, job state machine, 32-case Indian benchmark
├── prisma/
│   └── schema.prisma          # PostgreSQL relational schema
├── test/                      # Vitest integration and security regression tests
│   ├── health.test.ts
│   ├── auth-middleware.test.ts
│   ├── storage-and-upload.test.ts
│   ├── extraction-pipeline.test.ts
│   └── ai-benchmark.test.ts
├── docker-compose.yml         # Local development containers (PostgreSQL & MinIO)
└── .env.example               # Template environment configuration
```

---

## 4. Security & Multi-Tenant Invariants

- **Anti-Spoofing Ownership:** Every patient-owned endpoint derives `patientProfileId` exclusively from verified JWT session claims on the server. Client-provided patient IDs are never trusted as proof of ownership.
- **Private Object Storage:** Object keys format `documents/<patientProfileId>/<uuid>`. 15-minute TTL pre-signed URLs only. Public access is permanently blocked.
- **Magic Byte Verification:** File signatures (JPEG `FF D8 FF`, PNG `89 50 4E 47`, PDF `%PDF`) are strictly verified to prevent file disguised attacks.
- **Server-Side Checksums:** SHA-256 integrity calculated server-side.
- **No Unreviewed AI Data in Timeline:** Unreviewed AI extractions remain strictly in draft state. Verified clinical records are created only after explicit patient confirmation.
