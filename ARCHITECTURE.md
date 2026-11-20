# Architecture

This document explains how the service keeps money correct under duplicates, reordering and concurrency, why each choice was made, and what is left out.

## 1. Overview

```
HTTP ─────────────┐
                  ├─► SubmitWagerTransaction ─► one SQL transaction ─► wallets · transactions · ledger · outbox · inbox
SQS consumer ─────┘                                                              │
                                                                                 ├─► outbox publisher ─► SQS events queue
pending-reference worker ─► same business rules, later                           │
```

Everything that changes money goes through one use case, `SubmitWagerTransaction`, in one SQL transaction: the transaction row, the ledger entry, the new balance, the inbox record (for queue input) and the outbox events are committed together or not at all. Nothing is published before the commit: the use case only writes events to a table, and a separate worker sends them.

### Layers

| Layer | Contains | Depends on |
| --- | --- | --- |
| `domain` | `Money`, `Wallet`, `WalletLedgerEntry`, `WagerTransaction`, `InboxMessage`, `OutboxMessage` | nothing (only `decimal.js` inside `Money`) |
| `application` | use cases, ports (interfaces), integration events | `domain` |
| `infrastructure` | PostgreSQL adapters, SQS, workers, metrics, logs | `application`, `domain` |
| `presentation` | HTTP controllers, request parsing, error mapping | `application` |

The use cases depend on small ports (`WalletRepository`, `WagerTransactionRepository`, `LedgerRepository`, `OutboxRepository`, `InboxRepository`, `PendingReferenceRepository`, `UnitOfWork`, `MessagePublisher`, `ReadModel`) instead of one large repository. Nest injects the implementations by explicit token, because Bun does not emit decorator metadata. The domain and the use cases run in unit tests with in-memory doubles; only the integration tests need PostgreSQL and SQS.

## 2. Money

`Money` is an immutable value object: a `Decimal` plus a currency, never `number`. Input and output are decimal strings with exactly two decimals (`"25.00"`). The input pattern rejects empty strings, `NaN`, `Infinity`, scientific notation, signs, commas, spaces and more than two decimals; it does not round, because rounding silently changes what the provider sent. Operations between currencies throw. The model is multi-currency; the tests use `BRL` and also check that a currency different from the wallet's is refused.

In the database an amount is two columns, `numeric(20,2)` and `char(3)`. The repositories rebuild `Money` from them; there is no ORM-level money type, so nothing can turn an amount into a float on the way.

## 3. ORM choice

MikroORM, as preferred. The domain objects are plain classes with private constructors and `rehydrate` factories, so they are not mapped entities with decorators. The repositories use `EntityManager.transactional()` for the transaction and `em.execute()` for the SQL. That keeps the important statements visible and reviewable: `SELECT ... FOR UPDATE`, `... FOR UPDATE SKIP LOCKED`, `INSERT ... ON CONFLICT DO NOTHING`, and `UPDATE ... WHERE version = ?`. The Unit of Work and Identity Map of the ORM are not used, because the concurrency control here is deliberately explicit SQL. Migrations use the MikroORM migrator, versioned and reversible (`migrate:down`).

## 4. Database guarantees

The schema enforces the invariants, not only the code (README restriction 9). Each row below is tested by writing around the application.

| Guarantee | Mechanism |
| --- | --- |
| balance never negative | `CHECK (balance >= 0)` on `wallets` |
| one wallet per player and currency | `UNIQUE (player_id, currency)` |
| the same operation is processed once | `UNIQUE (idempotency_key)` and `UNIQUE (provider_id, external_transaction_id)` |
| transaction and ledger use the wallet's currency | composite foreign key `(wallet_id, currency)` |
| a transaction is reversed once per reversal kind | partial unique index on `(reference_transaction_id, kind)` where `status = 'PROCESSED'` and kind is `REFUND` or `ROLLBACK` |
| one ledger entry per wallet and transaction | `UNIQUE (wallet_id, transaction_id)` |
| ledger arithmetic | `CHECK` that `balance_after = balance_before ± amount` by direction |
| the ledger is append-only | triggers that reject `UPDATE`, `DELETE` and `TRUNCATE` |
| terminal transactions never change | trigger that rejects `UPDATE` when the old status is `PROCESSED`, `REJECTED` or `FAILED` |
| a queue message is consumed once | primary key `(consumer_name, message_id)` on `inbox_messages` |

## 5. Concurrency

The unit of concurrency is the wallet. The strategy is **pessimistic locking per wallet**, with a version check as a second barrier:

1. Inside the transaction, `SELECT * FROM wallets WHERE id = ? FOR UPDATE`. Requests for the same wallet queue in PostgreSQL; requests for other wallets do not wait for them. There is no global lock and no in-process lock, so it is correct with any number of instances.
2. The balance is saved with `UPDATE wallets SET balance = ?, version = ? WHERE id = ? AND version = ?`. Under the lock this always matches; if some code path ever changed a wallet without the lock, the update would affect zero rows and the request would fail instead of losing an update (`ConcurrentModificationError`).
3. Behind both, the constraints in section 4 reject the final bad state.

Why pessimistic and not optimistic with retry: a hot wallet (many bets per second) would make optimistic retries pile up and waste work, while a row lock is cheap and gives a simple argument for correctness. The cost is that one slow transaction delays the queue of its wallet; transactions are short (a handful of statements, no network calls inside) and the wait is exposed as `wallet_lock_wait_seconds`.

**Lock order.** The submit use case locks the wallet first. The worker that retries pending references also locks the wallet first and the transaction row second, so the two paths cannot deadlock each other.

## 6. Idempotency

The `Idempotency-Key` header is required and is the source of truth. The default recommended form is `{providerId}:{externalTransactionId}`, and the same key is used for queue messages (`data.idempotencyKey`).

**Payload hash.** SHA-256, hex, of the canonical JSON of the business fields only: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` (amount normalised through `Money`, so `"25.5"` and `"25.50"` hash the same) and `referenceExternalTransactionId` (`null` when absent). Canonical means keys sorted at every level. The header and transport metadata are not part of it.

**Flow** (inside the SQL transaction):

1. Look for a transaction with that key (or with the same provider and external id). Found: same payload hash → answer the original result with `idempotentReplay: true`, without taking the wallet lock; different payload → `409 IDEMPOTENCY_CONFLICT`.
2. Not found: take the wallet lock and **look again**. Requests with the same key queue on the lock, and the first one has usually committed by the time the others get it.
3. If two requests still reach the insert together (they hold different wallet locks, for example the same key sent with two different wallet ids), the unique constraint rejects one. The use case catches that violation and runs the whole attempt once more, which now finds the committed row and answers as a replay.

A replay returns the balance observed when the transaction was applied (`balance_after` is stored), not the current balance.

Idempotency lives in PostgreSQL only. There is no in-memory cache anywhere in the path.

## 7. Business rules and interpretations

| Operation | Effect | Ledger |
| --- | --- | --- |
| `BET` | debit; rejected with `INSUFFICIENT_FUNDS` if the balance is not enough | one `DEBIT` |
| `WIN` | credit | one `CREDIT` |
| `LOSS` | none; recorded as `PROCESSED` | none |
| `REFUND` | credit; must reference a `PROCESSED` `BET` | one `CREDIT` |
| `ROLLBACK` | inverse of the reference (a `BET` is credited back, a `WIN` is debited); references `BET`, `WIN` or `REFUND` | one entry, inverted |

Interpretations the README leaves open:

- **A reference** is resolved by `(providerId, referenceExternalTransactionId)` and must have the same provider, player, wallet, round and currency, and the exact same amount (partial reversals are out of scope).
- **"Reversed once by the same kind"** means one processed `REFUND` and one processed `ROLLBACK` can both exist for the same `BET`. The index is on `(reference, kind)`. A stricter reading (one reversal of any kind) is a one-line change of the index and of `hasProcessedReversal`.
- **A reference that was rejected** is not a valid target (`REFERENCE_NOT_PROCESSED`).
- **A reversal that would overdraw** (for example a `ROLLBACK` of a `WIN` already spent) is `REJECTED` with `REVERSAL_WOULD_OVERDRAW`, distinct from a bet without funds.
- **Currency or player different from the wallet** returns `422` without storing the transaction: the composite foreign key `(wallet_id, currency)` makes that row impossible to insert. This is a deliberate trade-off (see limitations).

### Failure codes

| Code | When | Provider should |
| --- | --- | --- |
| `INSUFFICIENT_FUNDS` | a bet larger than the balance | not resend |
| `REVERSAL_WOULD_OVERDRAW` | the reversal would make the balance negative | not resend |
| `REFERENCE_NOT_FOUND` | the reference never arrived (after the retry limit) | check the reference id |
| `REFERENCE_NOT_PROCESSED` | the reference exists but was rejected or failed | not resend |
| `REFERENCE_MISMATCH` | other provider, player, wallet or round | fix the payload |
| `REFERENCE_ALREADY_REVERSED` | already reversed by this kind | not resend |
| `INVALID_REFERENCE_KIND` | `REFUND` of a `WIN`, `ROLLBACK` of a `LOSS`, ... | fix the payload |
| `AMOUNT_MISMATCH` | amount differs from the reference | fix the payload |
| `CURRENCY_MISMATCH` | currency differs from the reference | fix the payload |

`WALLET_NOT_FOUND` and `INFRASTRUCTURE_ERROR` exist in the enum; the first is returned as `404` before any record is written, the second is reserved for a permanent infrastructure failure (`FAILED`) and is not produced today.

## 8. Reversals that arrive before their reference

If the reference is not there (or is itself still pending), the reversal is stored as `PENDING_REFERENCE`, nothing moves, an event `WagerTransactionPendingReference` is written and the HTTP answer is `202`.

A worker (`pending-reference-worker`, every 2 seconds when idle) selects the due ones, locks the wallet and then the row with `FOR UPDATE SKIP LOCKED`, and runs the same decision function as the submit use case. Outcomes: processed (credit or debit applied, events written), rejected (a business reason), or still waiting.

Backoff: 5 s, 10 s, 20 s, 40 s, 80 s, 160 s, then 300 s. **Limit: 10 attempts, about 25 minutes.** After that the reversal is `REJECTED` with `REFERENCE_NOT_FOUND` and a `WagerTransactionRejected` event. The window covers a provider that retries its own delivery for a few minutes while keeping the row from living forever. Both numbers are constants in `reprocess-pending-references.use-case.ts`.

## 9. Transactional outbox

The use case calls `OutboxRepository.add(events)` inside the financial transaction. Each event is an `IntegrationEvent` (abstract class, one subclass per event with its `eventType` and `version`), serialized as an envelope with `eventId`, `aggregateId`, `correlationId`, `causationId`, `occurredAt`, `version` and `data`. The `data` carries `MoneyProps` (decimal strings), never `Money` instances.

| Event | When |
| --- | --- |
| `WagerTransactionProcessed` | any applied transaction, `LOSS` included |
| `WagerTransactionRejected` | rejected by a business rule |
| `WalletBalanceChanged` | only when the balance changes |
| `WagerTransactionPendingReference` | reference missing |

**Publishing.** The `outbox-publisher` worker runs `PublishOutbox`: in one transaction it selects due, unpublished messages with `FOR UPDATE SKIP LOCKED`, sends each to `wager-events.fifo`, marks it published, and commits. `SKIP LOCKED` is what lets several publishers share the table: each one only sees the rows nobody else holds, so no event goes to two publishers at the same time. A failure schedules a retry with exponential backoff (1 s doubling up to 5 minutes) and keeps going with the rest of the batch.

**The crash case.** PostgreSQL commits, the process dies before publishing: the rows are still pending, the next instance publishes them. If the process dies after sending and before committing the "published" mark, the event is sent again. Delivery is therefore **at-least-once**. Two protections: the event id is the FIFO deduplication id (SQS drops a repeat inside its five-minute window), and every event carries a stable `eventId` so consumers can deduplicate for good. The window is an optimisation, not the guarantee.

## 10. Inbox and the SQS consumer

`ProcessWagerMessage` turns a `WagerTransactionRequested` message into the same command the HTTP endpoint builds and calls the same use case. Inside the use case's transaction it first inserts `(consumer_name, message_id)` into `inbox_messages` with `ON CONFLICT DO NOTHING`. If the row already exists, the message was already processed in full (the inbox row is written in the same transaction as the effects), so the answer is the original result and nothing is applied again. If two copies arrive at the same moment, the second insert waits for the first transaction and then sees the conflict.

The consumer (`SqsWagerConsumer`):

- **Ack only after the commit.** The message is deleted after the use case returns. If the process dies in between, the message comes back after the visibility timeout and the inbox absorbs it. Tested by losing the delete call.
- **Three kinds of outcome.**
  - *Business outcomes* (`PROCESSED`, `REJECTED`, `PENDING_REFERENCE`) are normal results: ack.
  - *Permanent errors* (not JSON, wrong type, unknown kind, malformed amount, unknown wallet, currency or player mismatch, idempotency conflict) cannot succeed on retry: the message is copied to the DLQ with a `failureReason` attribute and deleted.
  - *Transient errors* (database down, any unexpected error): the message returns to the queue with a growing delay (2 s, 4 s, 8 s ... up to 60 s). After 5 receives it goes to the DLQ with `RETRIES_EXHAUSTED`. The queue's own redrive policy (`maxReceiveCount` 5) is the backstop.
- **FIFO.** Messages of a wallet share a group id; the consumer handles different groups in parallel and one group in order. Ordering is an optimisation: the database is still what guarantees correctness, and reversals that arrive early are handled by section 8.
- **SIGTERM.** Nest shutdown hooks stop the consumer and the workers before the database pool closes. Polling is aborted, messages already received are finished, workers end their current tick. A message that was received but not finished returns to the queue by visibility timeout.

## 11. HTTP

One mapping for every endpoint, so a provider can decide from the status alone (full table in the README): `400` invalid payload or header, `404` unknown wallet or transaction, `409` idempotency or duplicate-wallet conflict, `422` business rejection or currency/player mismatch, `202` accepted with a pending reference, `200`/`201` replay or new, `503` transient infrastructure failure with `Retry-After`. Unexpected errors are `500` with a generic body (the detail goes to the log, not to the client).

## 12. Observability

- **Logs:** one JSON object per line with `time`, `level`, `context`, `message` and, where they apply, `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`. Amounts and payloads are not logged. The correlation id is the `X-Correlation-Id` header, or the message id for queue input, or the transaction id.
- **Metrics** (`GET /metrics`, Prometheus text format, in-process registry):

| Metric | Meaning |
| --- | --- |
| `wager_transactions_total{status,source}` | answers by resulting status, for HTTP and SQS |
| `wager_idempotent_replays_total{source}` | duplicates detected |
| `wager_retries_total{component}` | retries by consumer, outbox publisher and pending-reference worker |
| `wager_dlq_messages_total{reason}` | messages parked in the DLQ |
| `wallet_lock_conflicts_total` and `wallet_lock_wait_seconds` | lock acquisitions that had to wait (over 5 ms), and the wait histogram |
| `db_unique_violations_total{constraint}` | unique violations raised by the database (idempotency races that were caught) |
| `outbox_lag_seconds` | age of the oldest event not published |
| `wager_processing_seconds{source}` | processing time per transaction |
| `reconciliation_divergences_total` | reconciliations that found a difference |

- **Health:** `/health/live` only says the process is alive. `/health/ready` checks PostgreSQL (`select 1`) and the queues (`GetQueueAttributes`) and answers `503` if one is down. Both are open.
- **Reconciliation:** `POST /wallets/:id/reconciliation` reads the stored balance and the ledger sum in one statement. A divergence is logged, counted and returned (`consistent: false` with the difference); it is never corrected silently.

## 13. Authentication

Not implemented. It is outside what the challenge scores, and the README allows documenting the decision. The extension point is `AuthGuard` (`presentation/auth/auth.guard.ts`), registered globally and currently a no-op. The design I would adopt: an external OIDC identity provider (Keycloak or Zitadel), bearer tokens validated in that guard against the provider's JWKS, a `providerId` claim compared with the `providerId` in the body so a provider cannot write for another one, and `/health/*` and `/metrics` marked public. No user table and no password hashing in this service. Messages from the queue are treated as an internal trusted channel, as the README says, but their `providerId` still goes through the same domain validation.

## 14. Testing

Unit tests (domain and use cases, in-memory doubles) and integration tests (real PostgreSQL and the SQS API) as listed in the README. Concurrency tests use real parallelism: a pool of connections hitting the same wallet at once, and three separate `bun` processes that share the database and the queues. A deliberately broken variant (removing `FOR UPDATE`) makes the race tests fail, which is how I checked that they would catch the bug. Every concurrency test ends by comparing the stored balance with the ledger.

## 15. Known limitations and trade-offs

- **Rejections that cannot be stored.** A currency or player that does not match the wallet is answered `422` but not recorded, because the composite foreign key makes that transaction impossible to insert. Recording it would need the currency check to move from a foreign key to a trigger, or a separate rejections table.
- **A rejected or pending replay has no balance in the answer.** Only `PROCESSED` stores `balance_after`.
- **Publishing inside the database transaction.** The outbox publisher holds row locks while it calls SQS. It keeps the logic simple and correct (no row is published by two publishers at once), at the cost of lock time proportional to the batch size and to broker latency. A claim-then-publish scheme with a lease column would shorten the locks.
- **At-least-once events.** Consumers of `wager-events.fifo` must deduplicate by `eventId`.
- **FIFO queue throughput** is limited per message group; the group is the wallet, which matches the concurrency unit.
- **The retry window for pending references** (about 25 minutes, 10 attempts) is a chosen constant, not configuration.
- **One currency per test**, though the model supports several.
- **No load test** (`test:load`). The concurrency tests show correctness under contention, not throughput numbers.
- **Metrics are per process.** A scraper must read every instance.
