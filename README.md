# Distributed Wagering Processor

Backend service that processes wager transactions (BET, WIN, LOSS, REFUND, ROLLBACK) for player wallets, with a ledger, persistent idempotency and asynchronous processing over SQS.

Stack: Bun, TypeScript (strict), NestJS, MikroORM, PostgreSQL, AWS SQS (LocalStack), Docker Compose.

## Setup

```bash
cp .env.example .env
bun install
docker compose up -d
bun run migrate:up
bun run start
```

Health: `GET http://localhost:3000/health/live`

## Commands

| Command | What it does |
| --- | --- |
| `bun run start` | starts the API |
| `bun test` | runs the tests |
| `bun run typecheck` | type checks the project |
| `bun run migrate:up` | applies the migrations |
| `bun run migrate:down` | reverts the last migration |

## Structure

```
src/
  domain/          entities and value objects, no framework or database code
  application/     use cases and ports
  infrastructure/  persistence, messaging and other adapters
  presentation/    HTTP controllers and message consumers
```
