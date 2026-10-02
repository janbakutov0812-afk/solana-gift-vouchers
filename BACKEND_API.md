# Escrow API contract

The frontend expects `VITE_VOUCHER_API_URL` to be the API origin, for example `https://api.example.com`. It never receives an escrow private key. Set the frontend and backend to the same Solana cluster.

The repository's `backend/server.js` is a **local devnet prototype only**. It creates per-voucher secrets and stores them encrypted in an ignored local JSON file; this is not production custody, and it must not be pointed at mainnet or used for valuable funds. Its fee-sponsor key must have Devnet SOL to relay claims; new on-chain vouchers reserve the quoted transaction fee plus USDC token-account rent from the sender.

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

Response for an on-chain voucher (`onchain: true`):

```json
{
  "escrowAddress": "base58 public key",
  "voucherId": "escrow_abc123xyz",
  "giftHash": "base64url hash",
  "feeReserveLamports": "quoted sender-funded SOL reserve"
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

Response for the on-chain claim flow:

```json
{
  "onchain": true,
  "sponsoredTransaction": "base64 transaction, fee sponsor signature included",
  "feeSponsorAddress": "base58 public key",
  "blockhash": "recent blockhash",
  "lastValidBlockHeight": 123
}
```

The API verifies the separate secret phrase and prepares a transaction partially signed by the fee sponsor. The recipient still signs to authorize the payout, but does not pay the network fee. For USDC, the sponsor creates the recipient ATA if missing. The contract reimburses the sponsor from the sender-funded reserve and returns unused reserve to the sender. Non-on-chain legacy vouchers continue to return a payout `txHash`.

## Security and operations

- A link containing only a voucher ID is not sufficient to claim in the updated API: the recipient must also supply the separate secret phrase. Share the phrase through a different channel; anyone who gets both can claim.
- The separate passphrase is checked by the API, outside the Anchor program. Anyone who gets the voucher secret and phrase can claim; do not use valuable funds until this trust boundary and relayer flow have been independently reviewed.
- Keep signing keys in a secrets manager or use a reviewed on-chain program. Never put private keys in the frontend, browser storage, URLs, or `VITE_*` variables.
- Verify chain, token mint, amount, sender and destination from transaction data; do not trust client-submitted metadata.
- Apply replay protection, idempotency, rate limits, and origin/authentication controls.
- New on-chain gifts reserve SOL for a relayed claim. The sender funds the reserve at creation; the claim sponsor covers the transaction fee and any missing USDC ATA rent, and the contract reimburses the quoted cost.
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

Never prefix these secrets with `VITE_`. The public frontend API base defaults to the current site origin, so Vercel serves `/api/escrow/*` on the same HTTPS domain. The fee sponsor needs Devnet SOL before claims can succeed. The program upgrade and matching frontend/API release must be deployed together; the new instruction data is not compatible with the currently deployed program version. The local `backend/server.js` remains a devnet-only file-backed development server and must not be used as the Vercel runtime.

`GET /api/escrow/health` returns the fee payer's public address, configured network, and current SOL balance. It never returns the fee payer secret key.

Keep `ESCROW_MASTER_KEY` stable and backed up: it encrypts escrow signers and derives the secret-word pepper. Existing vouchers created before secret-word protection have no verifier and are rejected by the updated claim route; resolve/recreate any such devnet vouchers before rollout.
