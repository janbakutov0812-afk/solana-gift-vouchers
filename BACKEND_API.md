# Escrow API contract

The frontend expects `VITE_VOUCHER_API_URL` to be the API origin, for example `https://api.example.com`. It never receives an escrow private key. Set the frontend and backend to the same Solana cluster.

The repository's `backend/server.js` is a **local devnet prototype only**. It creates per-voucher custodial keypairs and stores their encrypted secret keys in an ignored local JSON file; this is not production custody, and it must not be pointed at mainnet or used for valuable funds. Its fee-payer key must have devnet SOL for claim transaction fees and USDC recipient token-account rent.

## Create and fund a voucher

Funding needs an escrow destination before the sender can sign a transfer. The frontend therefore calls `prepare` first, then submits the confirmed transaction to `create` for idempotent verification and persistence.

### `POST /api/escrow/prepare`

Request:

```json
{
  "senderAddress": "base58 public key",
  "amount": 0.25,
  "currency": "SOL",
  "templateId": "birthday",
  "message": "Поздравление",
  "secretWord": "секретная фраза из нескольких слов"
}
```

Response:

```json
{
  "escrowAddress": "base58 public key"
}
```

The API must validate the request, choose a cluster-specific escrow destination, and associate it with a short-lived intent. The destination should be unique per intent, especially for SOL, so incoming transfers can be attributed without ambiguity. For USDC, the frontend creates/transfers to the destination's associated token account.
The secret word is normalized, salted, and derived with scrypt plus a server-only pepper. Plaintext is never stored. Require at least 12 characters, rate-limit failed claims persistently, and tell the sender to share the phrase separately from the link.

### `POST /api/escrow/create`

After wallet signature and confirmed on-chain funding, the frontend sends:

```json
{
  "senderAddress": "base58 public key",
  "amount": 0.25,
  "currency": "SOL",
  "templateId": "birthday",
  "message": "Поздравление",
  "txHash": "confirmed Solana transaction signature"
}
```

Response:

```json
{ "status": "success", "voucherId": "escrow_abc123xyz" }
```

The backend must verify the confirmed signature against the prepared intent, cluster, sender, asset mint, amount and destination. Make this endpoint idempotent by transaction signature so the sender can safely retry if the API is temporarily unavailable after funding. Return errors as JSON with a `message` field and a non-2xx status.

## Read a voucher

### `GET /api/escrow/details?id=escrow_abc123xyz`

Return the voucher's template, amount, currency, message and `status` (`active` or `claimed`). The frontend validates the `id` query parameter before sending it. A claimed voucher remains readable so the recipient can see the card, but its claim button is disabled.

## Claim a voucher

### `POST /api/escrow/claim`

Request:

```json
{
  "voucherId": "escrow_abc123xyz",
  "recipientAddress": "base58 public key",
  "secretWord": "секретная фраза из нескольких слов"
}
```

Response:

```json
{ "txHash": "confirmed or submitted Solana transaction signature" }
```

The backend must validate the secret word before atomically reserving each eligible voucher, validate the recipient address, submit the payout, and make retries idempotent. Limit attempts per voucher using persistent storage (the current routes allow eight attempts per 15 minutes). The frontend waits for the returned transaction to confirm before displaying “Успешно выплачено”.

## Security and operations

- A link containing only a voucher ID is not sufficient to claim in the updated API: the recipient must also supply the separate secret phrase. Share the phrase through a different channel; anyone who gets both can claim.
- The current API protects the existing custodial MVP. The Anchor program is not connected to the site and does not yet enforce this passphrase or a server-authorized claim permit; do not deploy it for real funds until that claim flow is implemented and reviewed.
- Keep signing keys in a secrets manager or use a reviewed on-chain program. Never put private keys in the frontend, browser storage, URLs, or `VITE_*` variables.
- Verify chain, token mint, amount, sender and destination from transaction data; do not trust client-submitted metadata.
- Apply replay protection, idempotency, rate limits, and origin/authentication controls.
- USDC requires a destination associated token account. Decide which party or sponsor funds its rent-exempt balance and transaction fees.
- SOL and USDC vouchers need explicit expiry/refund behavior and a disclosed fee policy. A USDC transfer cannot pay a SOL-denominated fee directly.
- Do not use mainnet until custody, signing, recovery and payout flows have been reviewed.

## Vercel deployment

The production routes are implemented by `api/escrow/[action].js`; they use Neon Postgres so voucher state is not written to the temporary function filesystem. The function creates its table on first request. Connect a Neon Postgres database through the Vercel Marketplace and provide its server-only `DATABASE_URL` variable to the project.

Set these server-only Vercel variables before using the API:

- `ESCROW_NETWORK=devnet`
- `ESCROW_RPC_URL=https://api.devnet.solana.com` (or a trusted devnet RPC URL)
- `ESCROW_ALLOWED_ORIGINS=https://solana-gift-vouchers-nine.vercel.app`
- `ESCROW_MASTER_KEY` — 32 random bytes encoded as 64 hex characters
- `ESCROW_FEE_PAYER_SECRET_KEY` — base58-encoded 64-byte Solana keypair secret (JSON byte arrays are also accepted for compatibility)

Never prefix these secrets with `VITE_`. The public frontend API base defaults to the current site origin, so Vercel serves `/api/escrow/*` on the same HTTPS domain. The fee payer needs devnet SOL before claim transactions can succeed. The local `backend/server.js` remains a devnet-only file-backed development server and must not be used as the Vercel runtime.

Keep `ESCROW_MASTER_KEY` stable and backed up: it encrypts escrow signers and derives the secret-word pepper. Existing vouchers created before secret-word protection have no verifier and are rejected by the updated claim route; resolve/recreate any such devnet vouchers before rollout.
