# Distributed Wagering Processor

Backend service that processes wager transactions (BET, WIN, LOSS, REFUND, ROLLBACK) for player wallets. It keeps a ledger, makes every request idempotent in the database, and processes messages from SQS. It stays correct when messages are duplicated, arrive out of order, or are handled by several instances at once.

Stack: Bun, TypeScript (strict), NestJS, MikroORM, PostgreSQL 16, AWS SQS (LocalStack), Docker Compose.

The design decisions, the trade-offs and the known limitations are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Setup

You need Bun 1.x and Docker.

```bash
cp .env.example .env
bun install
docker compose up -d        # PostgreSQL and LocalStack (the queues are created on start)
bun run migrate:up
bun run start
```

The API listens on `http://localhost:3000`.

```bash
curl localhost:3000/health/live
curl localhost:3000/health/ready   # PostgreSQL and SQS reachable
```

To run several instances, start the app again with another port: `PORT=3001 bun run start`. They share the database and the queues, which is the point.

## Commands

| Command | What it does |
| --- | --- |
| `bun run start` | starts the API, the SQS consumer and the background workers |
| `bun test` | runs every test (needs `docker compose up -d` and `bun run migrate:up`) |
| `bun run test:unit` | domain and application tests only, no database or queue |
| `bun run test:integration` | tests against real PostgreSQL and SQS, including three app processes |
| `bun run typecheck` | type checks the project |
| `bun run migrate:up` | applies the migrations |
| `bun run migrate:down` | reverts the last migration |
| `bash scripts/smoke.sh` | calls a running API end to end (50 identical requests in parallel included) |

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATABASE_URL` | see `.env.example` | PostgreSQL connection |
| `AWS_ENDPOINT_URL`, `AWS_REGION` | LocalStack | SQS endpoint |
| `WAGER_QUEUE_URL` | | FIFO queue the consumer reads |
| `WAGER_DLQ_URL` | | FIFO dead-letter queue |
| `WAGER_EVENTS_QUEUE_URL` | | FIFO queue the outbox publisher writes to |
| `CONSUMER_ENABLED` | `true` | `false` runs the instance without the SQS consumer |
| `WORKERS_ENABLED` | `true` | `false` runs it without the outbox publisher and the pending-reference worker |
| `LOG_LEVEL` | `info` | `silent` turns the JSON logs off |

## API

| Method and path | What it does |
| --- | --- |
| `POST /wallets` | creates a wallet; a positive initial balance becomes an `OPENING` transaction with a ledger entry |
| `GET /wallets/:walletId` | balance and version |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | ledger entries, oldest first, opaque cursor |
| `POST /wallets/:walletId/reconciliation` | compares the stored balance with the ledger; reports, never fixes |
| `POST /wagering/transactions` | submits a transaction (header `Idempotency-Key` is required) |
| `GET /wagering/transactions/:transactionId` | one transaction |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | one transaction by the provider's id |
| `GET /health/live`, `GET /health/ready` | liveness and readiness |
| `GET /metrics` | Prometheus text format |

Submitting a bet:

```bash
curl -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "<player uuid>",
    "walletId": "<wallet uuid>",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
```

`REFUND` and `ROLLBACK` also send `referenceExternalTransactionId`.

### What the status code tells the provider

| Status | Meaning | What to do |
| --- | --- | --- |
| `201` | new transaction, processed | nothing |
| `200` | the same request again: the original result, `idempotentReplay: true` | nothing |
| `202` | `REFUND`/`ROLLBACK` accepted, its reference has not arrived yet | wait; it is retried by a worker |
| `400` | invalid payload, missing `Idempotency-Key`, malformed amount | fix the request |
| `404` | wallet or transaction not found | fix the ids |
| `409` | conflict: same key or external id with a different payload, or duplicated wallet | do not resend as is |
| `422` | a business rule said no (`status: REJECTED` with a `failureCode`), or currency/player does not match the wallet | repeating will not help |
| `503` | PostgreSQL or another dependency is unavailable (`Retry-After` is set) | resend with the same `Idempotency-Key` |

Failure codes: `INSUFFICIENT_FUNDS`, `REVERSAL_WOULD_OVERDRAW`, `REFERENCE_NOT_FOUND`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_MISMATCH`, `REFERENCE_ALREADY_REVERSED`, `INVALID_REFERENCE_KIND`, `AMOUNT_MISMATCH`, `CURRENCY_MISMATCH`. Their meaning is in ARCHITECTURE.md.

### Queue

The consumer reads `wager-transactions.fifo` and runs the same use case as the HTTP endpoint:

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-11-20T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "<player uuid>",
    "walletId": "<wallet uuid>",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

Integration events (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`) go to `wager-events.fifo`, published from the outbox after the commit.

## Structure

```
src/
  domain/          entities and value objects, no framework or database code
  application/     use cases and ports (interfaces)
  infrastructure/  PostgreSQL, SQS, workers, metrics
  presentation/    HTTP controllers
test/
  integration/     real PostgreSQL and SQS, concurrency, three app processes
  support/         helpers for the integration tests
docker/            LocalStack queue setup
scripts/           smoke test
```

## Tests

`bun run test:unit` covers the domain and the use cases with in-memory doubles. `bun run test:integration` uses the real PostgreSQL and the SQS API of LocalStack, including:

- the same bet sent 50 times in parallel debits once;
- two bets of 80.00 against 100.00: one processed, one rejected, balance 20.00, one debit in the ledger;
- different wallets in parallel, and a hot wallet that must never go negative;
- a worker that dies after the commit and before the ack (redelivery changes nothing);
- two outbox publishers on the same outbox, and a broker that is down after the commit;
- a reversal that arrives before its reference;
- three app processes at once, one killed with `SIGKILL` in the middle and restarted, one stopped with `SIGTERM`.

Every concurrency test ends by checking that the stored balance equals the balance rebuilt from the ledger. The integration tests reuse the same database between runs, so they use fresh ids each time.
