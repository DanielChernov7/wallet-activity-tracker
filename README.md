# Wallet Activity Tracker

Production-grade multi-chain wallet monitoring service: real-time listeners for EVM (Ethereum / Base / Arbitrum) and Solana, an enrichment pipeline (decode → price → label → wallet linking), a rules-based alerting engine, and multi-channel notifications (Telegram, webhooks, WebSocket).

## Architecture

```
┌─────────────────────────────────────┐
│           Chain Listeners           │
│  EVM (ethers.js WebSocketProvider)  │
│  Solana (web3.js onLogs / gRPC*)    │
└──────────────┬──────────────────────┘
               │ raw tx event
               ▼
┌─────────────────────────────────────┐
│          BullMQ pipeline            │
│  raw_transactions → parse_and_enrich│
│                   → notify          │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│        Enrichment pipeline          │
│  classify tx · token prices (USD)   │
│  address labels · wallet linkage    │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│       PostgreSQL + Prisma           │
│  wallets · transactions · alerts    │
│  alert_events · address_labels      │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│         Notification Layer          │
│  Telegram / Webhook / WebSocket     │
└─────────────────────────────────────┘
```

`*` Solana baseline uses RPC `onLogs`; swap to Yellowstone gRPC (geyser) for production throughput.

## Layout

```
src/
  config/        env + pino logger
  db/            prisma client
  chains/        ChainListener interface + EVM/Solana adapters
  queues/        BullMQ queues & connection
  pipeline/      enrichment (decode → price → label)
  prices/        Jupiter / CoinGecko adapters with TTL cache
  alerts/        condition engine (amount_gt, contract, unusual_activity)
  notifications/ telegram, webhook, in-process WS hub
  api/           Fastify REST + /ws
  worker.ts      raw → enrich → notify workers
  index.ts       boots chain listeners
prisma/schema.prisma
docker-compose.yml  (postgres + redis)
```

## Setup

```bash
cp .env.example .env          # fill in RPC + Telegram
docker compose up -d          # postgres + redis
npm install
npm run prisma:generate
npm run prisma:migrate -- --name init
npm run db:seed              # populate AddressLabel with CEXes / DEXes / tokens
```

## Running

Three processes (separate terminals or process manager):

```bash
npm run api      # Fastify REST + WebSocket on :3000
npm run worker   # BullMQ workers: raw → enrich → notify
npm run dev      # chain listeners → raw queue
```

## API surface

| Method | Path                              | Purpose                          |
| ------ | --------------------------------- | -------------------------------- |
| GET    | `/health`                         | liveness + ws client count       |
| GET    | `/wallets`                        | list tracked wallets             |
| POST   | `/wallets`                        | add/upsert wallet                |
| DELETE | `/wallets/:id`                    | soft-delete (active=false)       |
| GET    | `/wallets/:id/transactions`       | last 100 txs                     |
| POST   | `/alerts`                         | create alert rule                |
| DELETE | `/alerts/:id`                     | remove alert                     |
| WS     | `/ws`                             | real-time tx + alert stream      |

### Alert conditions

```jsonc
{ "type": "amount_gt", "valueUsd": 10000 }
{ "type": "contract_interaction", "contract": "0x..." }
{ "type": "unusual_activity", "windowSec": 300, "minCount": 10 }
{ "type": "any" }
```

### Alert channels

```jsonc
{ "telegram": true, "webhook": "https://...", "websocket": true }
```

## Design notes

- **Strategy pattern for chains** — `ChainListener` interface; adding a new network = one class.
- **Decoupled pipeline via BullMQ** — exponential backoff, DLQ via `removeOnFail` retention, horizontal scaling by adding worker processes.
- **Cache layer for prices** — 60s TTL per token to absorb provider rate limits; replace with Redis for multi-instance.
- **Per-channel error isolation** in the notify worker — one failing webhook doesn't block Telegram delivery.
- **Idempotency** — `Transaction` is uniquely keyed by `(chain, hash, from, to)`; raw worker upserts.
- **Graceful shutdown** — SIGINT/SIGTERM close all listeners and workers cleanly.
- **WS hub is in-process** — multi-instance deployments should back it with Redis pub/sub.
