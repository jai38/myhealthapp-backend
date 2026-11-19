# Ayoreni backend: rules for Claude sessions

This is the **backend session's** repo. Before you work, read the private shared repo `jai38/ayoreni-docs`: its `CLAUDE.md` holds the full non-negotiable rules, and `docs/STATUS.md`, `docs/WORKING-AGREEMENT.md`, the current phase brief and `docs/contracts/api.md` hold the rest. Also check the open issues labelled `from-ui` here. When you stop, update the backend section of `docs/STATUS.md` there.

**This repo is public.** No owner details, emails, account numbers, plans or patient data in code, commits, issues or PRs.

## Stack and commands

Node 22, Express 4, TypeScript strict, Prisma 5, PostgreSQL. ESM with `.js` import specifiers.

```bash
npm ci
npx prisma generate
npm run typecheck
npm test                 # the Docker integration suite skips without containers
docker compose up -d     # local Postgres on 5433, MinIO on 9000/9001
npm run dev              # port 4000
npm run seed:dev -- --target dev --reset   # synthetic dev data; refuses prod
```

## Deploys and infrastructure

- A push to `main` runs CI only. Production deploys are the manual `deploy-aws.yml` workflow; the dev copy uses `deploy-aws-dev.yml`. Merge to `main` and run a deploy only when the owner says.
- **Never** run `terraform plan` or `apply`, use AWS credentials, or open or edit `infra/envs/*.tfvars` or `.env`. Changing `infra/*.tf` is fine on a branch; the owner applies it.
- ECS container settings come from `infra/ecs.tf`. The owner runs `terraform apply`, then the deploy workflow.
- `APP_MIN_VERSION` and `APP_LATEST_VERSION` must be `x.y.z`, with the minimum no higher than the latest. A blank or invalid value stops the API at startup.
- Extraction uses Gemini `gemini-3.5-flash-lite` with no sampling parameters. The model id is `DEFAULT_GEMINI_MODEL` in `src/modules/ai-extraction/gemini-provider.ts` and `gemini_model` in `infra/variables.tf`.

## Rules you will touch most here

- Identity comes from the verified JWT only. Cross-patient access returns 404.
- Storage keys are `documents/<patientProfileId>/<uuid>`. Signed URLs last 15 minutes at most. Uploads fail closed.
- No health data in logs or audit records. `validateProductionConfig()` stays intact.
- AI output is a draft until the patient confirms it. Historical prescriptions are not active and never create reminders.
- Any change to an endpoint updates `docs/contracts/api.md` in `ayoreni-docs` in the same piece of work.
- Touching a security or clinical rule requires a regression test.
