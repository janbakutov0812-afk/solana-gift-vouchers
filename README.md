# Solgift — crypto gifts in one link

> Create a digital greeting card with SOL or USDC and send it to someone you care about with a single link.

**Status:** MVP frontend. Real voucher creation and claiming require an escrow backend, which is not included in this repository. Without `VITE_VOUCHER_API_URL`, the frontend will not submit a funding transaction.

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

Actual voucher creation and claiming require a running escrow backend. Without one, you can launch and explore the interface, but funding transactions are not submitted and payouts are not made.

## Architecture

```text
Sender ── creates voucher ──▶ Frontend ── prepare/fund ──▶ Escrow backend
                                  │                              │
                                  └── signs transfer ──▶ Solana RPC

Recipient ── opens link ──▶ Frontend ── reads voucher ──▶ Escrow backend
      └── connects wallet ◀── payout after claim ◀─────────────┘
```

The frontend does not store the escrow private key. See [BACKEND_API.md](./BACKEND_API.md) for the requirements for `prepare`, `fund`, voucher lookup, and `claim`.

## Tech stack

| Layer | Technologies |
| --- | --- |
| Interface | React 19, Vite 6, CSS, Tailwind CSS configuration |
| Wallet and transactions | Solana Wallet Adapter, `@solana/web3.js`, `@solana/spl-token` |
| Animation and icons | Framer Motion, Lucide |
| Escrow | Separate backend defined by `BACKEND_API.md`; not included in this repository |

## Quick start

Requirements: Node.js 18+ and npm.

```bash
git clone https://github.com/janbakutov0812-afk/solana-gift-vouchers.git
cd solana-gift-vouchers
npm ci
cp .env.example .env
npm run dev
```

The default network is Solana devnet. To enable the escrow flow, set `VITE_VOUCHER_API_URL` to the public base URL of your escrow API.

| Variable | Purpose | Default example |
| --- | --- | --- |
| `VITE_SOLANA_NETWORK` | Network label and USDC mint selection | `devnet` |
| `VITE_SOLANA_RPC_URL` | RPC endpoint | `https://api.devnet.solana.com` |
| `VITE_VOUCHER_API_URL` | Escrow API base URL | Empty |

When changing networks, keep `VITE_SOLANA_NETWORK` and `VITE_SOLANA_RPC_URL` in sync. Do not use mainnet until the escrow flow has been implemented and reviewed; the frontend alone cannot provide secure custody or prevent duplicate payouts.

To create a production build, run `npm run build`. The output is written to `dist/`.

## Roadmap

These are proposed next steps, not implemented features:

- Build and deploy the escrow backend or a reviewed on-chain escrow program.
- Add voucher persistence, expiration, and atomic protection against duplicate claims.
- Exercise error and retry scenarios for SOL and USDC on devnet.
- Prepare a secure production process before considering mainnet.

## Security

- Never put private keys, seed phrases, or other secrets in the frontend, `VITE_*` environment variables, or GitHub.
- The frontend intentionally does not submit a transfer when the escrow API is not configured.
- Do not use mainnet vouchers until the backend or on-chain escrow is implemented and reviewed.

---

## License

No license has been added to this repository yet.
