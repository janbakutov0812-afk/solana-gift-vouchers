# Solgift — crypto gifts in one link

> Create a digital greeting card with SOL or USDC and send it to someone you care about with a single link.

**Status:** MVP frontend with a local devnet escrow API. Do not use the local custodial server with real funds or mainnet.

[Escrow API contract](./BACKEND_API.md) · [GitHub repository](https://github.com/janbakutov0812-afk/solana-gift-vouchers)

---

## Problem and solution

Sending cryptocurrency to someone who is new to Web3 can mean explaining wallet addresses, wallets, and transaction steps. Solgift turns a transfer into a familiar gift experience: a designed greeting card, a personal message, and a link for the recipient.

The sender chooses a design, SOL or USDC, and an amount. The recipient opens the link, connects a wallet, and claims the gift. A separate escrow backend must handle funding verification and prevent a voucher from being claimed more than once.

## Why Solana

- The app supports gifts denominated in SOL or USDC on Solana.
- Wallet connections use Solana Wallet Adapter, and transactions are confirmed through RPC.
- The gift is designed to be shared as a link, so the sender does not need to collect the recipient's wallet address in advance.

## MVP features

- Phantom wallet connection and SOL balance display.
- SOL or USDC selection, amount entry, a personal message, and four greeting card designs.
- Gift preview and recipient screen.
- Funding transaction preparation through the API, wallet signing, and on-chain confirmation.
- Voucher lookup by link ID and a claim request through the API.

Voucher creation and claims require the local escrow API to be running. The development API uses temporary custodial signers and devnet only.

## Architecture

```text
Sender ── creates voucher ──▶ Frontend ── prepare/fund ──▶ Escrow backend
                                  │                              │
                                  └── signs transfer ──▶ Solana RPC

Recipient ── opens link ──▶ Frontend ── reads voucher ──▶ Escrow backend
      └── connects wallet ◀── payout after claim ◀─────────────┘
```

The frontend does not store the escrow private key. See [BACKEND_API.md](./BACKEND_API.md) for API behavior and security requirements.

An initial on-chain Anchor escrow is being developed in [`programs/solgift_escrow`](./programs/solgift_escrow/README.md). The current website still calls the Vercel escrow API; it does not yet use this program. The on-chain implementation is a dev-stage prototype and must not receive valuable funds before dedicated tests, a devnet acceptance flow, a verified build, frontend integration, and independent review.

## Tech stack

| Layer | Technologies |
| --- | --- |
| Interface | React 19, Vite 6, CSS, Tailwind CSS configuration |
| Wallet and transactions | Solana Wallet Adapter, `@solana/web3.js`, `@solana/spl-token` |
| Animation and icons | Framer Motion, Lucide |
| Escrow | Local devnet API in `backend/server.js`; not suitable for production |

## Quick start

Requirements: Node.js 18+ and npm.

```bash
git clone https://github.com/janbakutov0812-afk/solana-gift-vouchers.git
cd solana-gift-vouchers
npm ci
npm run dev:setup # creates ignored .env.local and local devnet signing keys (once)
npm run dev:api   # terminal 1: local Escrow API
npm run dev       # terminal 2: Vite frontend
```

The default network is Solana devnet. `.env.local` points the frontend to `http://localhost:8787` and is excluded from Git.

| Variable | Purpose | Default example |
| --- | --- | --- |
| `VITE_SOLANA_NETWORK` | Network label and USDC mint selection | `devnet` |
| `VITE_SOLANA_RPC_URL` | RPC endpoint | `https://api.devnet.solana.com` |
| `VITE_VOUCHER_API_URL` | Escrow API base URL | `http://localhost:8787` in `.env.local` |

Keep `VITE_SOLANA_NETWORK` and `VITE_SOLANA_RPC_URL` in sync. The included API refuses to run on mainnet; it is a local development server, not a production custody system.

To create a production build, run `npm run build`. The output is written to `dist/`.

## Roadmap

These are proposed next steps:

- Replace the local custodial development API with a reviewed on-chain escrow program or hardened production backend.
- Add voucher persistence, expiration, and atomic protection against duplicate claims.
- Exercise error and retry scenarios for SOL and USDC on devnet.
- Prepare a secure production process before considering mainnet.

## Security

- Never put private keys, seed phrases, or other secrets in the frontend, `VITE_*` environment variables, or GitHub.
- The local backend stores voucher signing keys encrypted in an ignored development data file; protect and delete that file if no longer needed.
- Do not use the local escrow server with mainnet or valuable assets.

---

## License

No license has been added to this repository yet.
