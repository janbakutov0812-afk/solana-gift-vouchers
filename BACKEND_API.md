# Escrow API contract

The browser never receives an escrow private key. Deploy a trusted backend or an audited on-chain escrow program before enabling real gifts. The frontend expects `VITE_VOUCHER_API_URL` to expose these JSON endpoints:

- `POST /vouchers/prepare` with `{ creator, currency, amount, template, message }` returns `{ voucherId, escrowAddress }`. Create an expiring, one-time intent in durable storage. The escrow address must belong to this intent.
- `POST /vouchers/:id/fund` with `{ creator, signature }` verifies the confirmed transfer on the selected cluster, token mint, amount, destination and creator, then marks the intent funded. It must be idempotent.
- `GET /vouchers/:id` returns `{ voucherId, currency, amount, template, message }` for funded, unclaimed vouchers only.
- `POST /vouchers/:id/claim` with `{ recipient }` atomically reserves an eligible voucher, pays the recipient from the escrow signer, submits the transaction, and returns `{ signature, blockhash, lastValidBlockHeight }`. Enforce one claim per voucher and handle retries idempotently.

The claim service must apply the requested 5,000-lamport (0.000005 SOL) fee policy to SOL vouchers and account for the actual network fee. A USDC transfer cannot pay a SOL-denominated fee out of USDC; the backend escrow must hold SOL for that fee or define a clearly disclosed conversion policy. Check balances, prevent replay/double claims, validate recipient addresses, and keep signing keys in a secrets manager or use a program-derived escrow. Add rate limits and origin/authentication controls. Do not store private keys in the frontend, URL, browser storage, or `VITE_*` variables.

USDC mint is selected from the configured network: the Circle devnet mint on devnet and the canonical USDC mint on mainnet-beta. The wallet UI defaults to devnet; do not point it at mainnet until backend, custody, and transaction handling have been reviewed.
