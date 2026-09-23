---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-09-20T17:46:47-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-22T22:19:37-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-09-22T23:02:31-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-20T17:46:47-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-09-20T17:46:47-03:00"
  docs/phases/phase-02-auth/context.md: "2026-09-20T17:46:47-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-09-20T17:46:47-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** No explicit subproject mentions found in this phase's text (no `Subprojetos:` line and no direct references to `nestjs-project` / `nextjs-project` / `next-frontend` paths).

**Deferred subprojects:** _None._

**Sequencing notes:** > Depende de: Fase 01, Fase 02

**Neighbors (for boundary detection only):**

- **Phase 02:** Fase 02 — Cadastro, Login e Gerenciamento de Conta (Depende de: Fase 01)
- **Phase 04:** Fase 04 — Gerenciamento de Vídeos e Canal (Depende de: Fase 02, Fase 03)

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Object Storage Technology & Bucket Strategy | decided | A | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-02 | phase | Backend | Queue & Background Worker Technology | decided | A | @nestjs/bullmq, bullmq |
| phase-03-videos/TD-03 | phase | Backend | Large Video Upload Strategy & Resumability | decided | B | — |
| phase-03-videos/TD-04 | phase | Backend | Draft Pre-registration & Video Status Lifecycle | decided | A | — |
| phase-03-videos/TD-05 | phase | Backend | Worker Execution Model & Metadata/Thumbnail Extraction | decided | B | — |
| phase-03-videos/TD-06 | phase | Backend | Unique Public Identifier Strategy | decided | A | nanoid |
| phase-03-videos/TD-07 | phase | Backend | Video Visibility & Access Control by Status | decided | B | — |
| phase-03-videos/TD-08 | phase | Backend | Streaming & Download Delivery Mechanism | decided | B | — |
| phase-03-videos/TD-09 | phase | Backend | Object Storage & Async Processing Testing Strategy | decided | A | — |
| phase-03-videos/TD-10 | phase | Backend | Accepted Video MIME Types & Format Validation | decided | B | — |
| phase-03-videos/TD-11 | phase | Backend | Abandoned Draft & Incomplete Multipart Upload Cleanup Policy | decided | A | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-01, phase-03-videos/TD-09 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-02, phase-03-videos/TD-09 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-03, phase-03-videos/TD-09, phase-03-videos/TD-10, phase-03-videos/TD-11 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-04, phase-03-videos/TD-07, phase-03-videos/TD-11 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-05, phase-03-videos/TD-09 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05, phase-03-videos/TD-09 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-06, phase-03-videos/TD-07 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-08 |
| Download do vídeo pelo usuário | phase-03-videos/TD-08 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** MinIO is the only option that keeps the environment fully Docker Compose-based, shares the exact SDK surface with production S3 (`@aws-sdk/client-s3`), and natively supports the Presigned URL flow that TD-03 depends on.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

### phase-03-videos/TD-02

**Recommendation:** `@nestjs/bullmq` is the project's de facto standard for background jobs in this stack, satisfies the retry/backoff/DLQ needs of a flaky FFmpeg step, and keeps the Compose footprint minimal.
**Libraries:** @nestjs/bullmq, bullmq

### phase-03-videos/TD-03

**Recommendation:** S3 Multipart Presigned Upload is the only option that actually satisfies the project-plan.md resumability requirement while reusing the same S3 SDK/presigner tooling already needed for TD-01, without introducing a new protocol/server (Option C).
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** the 5-state enum is the minimum model that satisfies every capability bullet in this phase (draft pre-registration, async processing visibility, failure surfacing) without adding states or infrastructure the phase doesn't need. BullMQ's own job history covers ad-hoc debugging needs that Option C would otherwise address. `status` is independent from Phase 04's future editorial `visibility`/`published` state.
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** a dedicated worker container reusing the NestJS codebase gives full type/entity reuse while fully isolating FFmpeg's CPU/memory footprint from the API, consistent with the project's self-hosted Docker Compose architecture (no external vendor dependency).
**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** `nanoid` gives short, non-reversible, collision-resistant public URLs without compromising the UUID primary-key convention already established in `User`/`Channel`.
**Libraries:** nanoid

### phase-03-videos/TD-07

**Recommendation:** `404 Not Found` is consistent with the enumeration-prevention intent that already motivated the `nanoid` slug in TD-06; a 403 on an unguessable slug would leak exactly the information the slug was chosen to hide.
**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** for this phase's actual requirements, redirecting both streaming and download to presigned GET URLs keeps the API fully out of the byte-proxying business, while MinIO/S3's native `Range` support on presigned URLs means playback scrubbing still works correctly.
**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** real MinIO and real FFmpeg-on-fixtures match this project's already-validated testing philosophy (Postgres and Mailpit are both "real via Docker") and are the only way to genuinely exercise the presigned-URL contract and FFmpeg's actual output.
**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** combining a fast client-side hint with authoritative worker-side validation via `ffprobe` gives the best UX/correctness balance, and the worker check is essentially free since `ffprobe` already runs for TD-05.
**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** a single BullMQ repeatable job keeps both DB and storage cleanup logic in one place, reuses infrastructure TD-02 already commits to, and avoids the two-TTL synchronization risk of a bucket-lifecycle-only approach.
**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, zero custom wiring, native string-to-number coercion.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — Clear file boundaries per domain, typed injection via `ConfigType<typeof xxxConfig>`, natural scalability. The `registerAs()` factory is dual-purpose: DI token + plain importable function.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — `data-source.ts` imports the factory, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. PostgreSQL is already in the stack, so no new infrastructure needed.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: previous tokens should be invalidated on a new request. Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (Mailpit in dev), no vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), class-validator is the documented NestJS approach.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes without RFC 9457's URI-based type system overhead. A simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration: guard system allows scoping rate limiting to specific modules via `APP_GUARD`, with `@SkipThrottle()` for exemptions. Single-instance, in-memory storage is sufficient.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`).

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — Strict `[a-z0-9_]` allowlist is the simplest and most portable choice; the `user_<random>` fallback provides a valid handle even for extreme email prefixes.

**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** Option A (`@nestjs/swagger`) — the only option that preserves the previously decided validation stack (`class-validator`, phase-02-auth/TD-06) without a re-platform; the CLI plugin with `classValidatorShim: true` leverages existing `class-validator` decorators to infer schemas, keeping boilerplate low.

**Libraries:** `@nestjs/swagger`

**Revisions:**
- 2026-05-12 — Clarifies that the CLI plugin (`classValidatorShim: true`) covers only DTO schema inference from `class-validator`; operation docs, per-status-code typed responses, error contracts (aligned to phase-02-auth/TD-07's envelope), and examples require explicit decorators (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`). This enrichment is part of the chosen Option A, not out-of-scope work.

### openapi-docs-nestjs/TD-02

**Recommendation:** Option C (Both — runtime UI + static artifact) — the marginal cost over Option A is a single npm script (~15 lines), and the benefit is a correct foundation for future FE integration (offline codegen) without losing the interactive UI dev/QA use.

**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Option B (dev/staging only) — aligns with the defensive posture already established in phase 02 (rate limiting, refresh rotation) and doesn't compromise legitimate consumers — the committed `openapi.json` (TD-02) serves as the "spec inspectable outside the UI" role.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports the relevant config factory and calls it as a plain function. _(from phase 01)_
- Config parameters are sourced from a single namespaced factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [xxxConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_
- Password/secret hashing uses Argon2id (`argon2` lib) where applicable. _(from phase 02)_
- Auth uses custom guards + `@nestjs/jwt` (not `@nestjs/passport`) — smaller dependency surface. _(from phase 02)_
- Request validation uses `class-validator` + `class-transformer` DTOs, enforced globally by `ValidationPipe`. _(from phase 02)_
- Domain errors use a custom `DomainException` base class + `@Catch(DomainException)` filter, normalized to `{ statusCode, error, message }`; a separate filter normalizes `class-validator` errors to the same shape; framework `HttpException`s pass through NestJS's default handling. _(from phase 02)_
- Rate limiting uses `@nestjs/throttler`, scoped per module via `APP_GUARD`, with `@SkipThrottle()` for exemptions; in-memory storage (single-instance, no distributed requirement). _(from phase 02)_
- Public-facing slugs/handles use a strict allowlist charset with a random fallback for edge-case inputs (established for channel nicknames). _(from phase 02)_
- API documentation uses `@nestjs/swagger` with the CLI plugin (`classValidatorShim: true`) plus explicit `@ApiOperation`/`@ApiResponse`/`@ApiBody`/`@ApiParam`/`@ApiQuery` decorators for operation docs, typed per-status responses, and error contracts; both a runtime UI (`/api/docs`, dev/staging only) and a static `openapi.json` artifact are maintained. _(from openapi-docs-nestjs)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|-----------|--------|-----------|---------|
| (empty on first assembly — plan-resolve appends rows as user marks capabilities) |

## Testing Requirements

### nestjs-project

| Artifact created | Required tests | Guide |
|---|---|---|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` | `artifacts/entities.md` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract | `artifacts/services.md` |
| Service with DB only (no branching) | Integration: DB contract | `artifacts/services.md` |
| Service with configured lib (JWT, cache) | Unit: real lib with test config | `artifacts/services.md` |
| Service with side-effect dep (email, storage, queue) | Integration: real capture service (Mailpit) or real dependency (MinIO, Redis) — see `phase-03-videos/TD-09` | `artifacts/services.md` |
| Module with configured imports | Unit: compilation test | `artifacts/modules.md` |
| Controller | E2E only — do NOT write unit tests | `artifacts/controllers.md` |
| DTO | E2E: one validation wiring test per endpoint | `artifacts/dtos.md` |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic | `artifacts/guards.md` |
| Guard (simple, delegates to Passport) | E2E only | `artifacts/guards.md` |
| Strategy (Passport) | E2E via guard | `artifacts/strategies.md` |
| Pipe (custom transformation/validation) | Unit | `artifacts/pipes.md` |
| Interceptor (response transform, logging) | Unit and/or E2E | `artifacts/interceptors.md` |
| Exception Filter | Unit + E2E | `artifacts/filters.md` |
| Middleware | E2E | `artifacts/middleware.md` |

**Phase-specific note (per `phase-03-videos/TD-09`, pending decision):** `testing-guide-nestjs-project`'s `references/external-systems.md` currently documents "Object Storage — Local Filesystem" as the test strategy, which predates and conflicts with the presigned-URL upload architecture (TD-01/TD-03). Once TD-09 is decided, the testing guide's Object Storage section should be updated to reflect real MinIO (Docker) as the test dependency, consistent with the guide's existing "Message Queue — Real (Docker)" (BullMQ+Redis, already aligned) and "Email — Mailpit (Real SMTP)" sections.
