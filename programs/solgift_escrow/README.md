# Solgift Escrow program

An Anchor program that replaces the prototype's server-held voucher keypairs with on-chain PDA escrow for native SOL and canonical USDC. The client generates a random 32-byte bearer secret and stores it in the shared link. The program stores only `SHA-256(secret)` and derives the gift PDA from `gift`, creator, and that hash. Anyone who knows the secret can claim before expiry; only the creator can refund after expiry. The preimage is revealed in the claim transaction, so this remains bearer-link security and is not a substitute for an audited recipient-authorization flow.

## Instructions

- `create_sol_gift(gift_hash, amount_lamports, expires_at)` — initialize the state PDA and fund it atomically. The client computes the hash locally; never send the secret in this transaction.
- `create_usdc_gift(gift_hash, amount, expires_at)` — initialize state and the PDA's USDC associated token account, then fund it atomically.
- `claim_sol_gift(gift_hash, gift_secret)` / `claim_usdc_gift(gift_hash, gift_secret)` — verify the preimage, pay the signing recipient before expiry, and mark the gift claimed in the same transaction.
- `refund_expired_sol_gift(gift_hash)` / `refund_expired_usdc_gift(gift_hash)` — return escrow to the creator after expiry.

`expires_at` must be a future Unix timestamp no more than 365 days after creation. The frontend should default to 30 days and display the refund rule before funding. Claim/refund races are resolved by Solana's account write lock and the active-status check; a failed transfer rolls back the status change.

USDC is restricted to the legacy SPL Token program and the canonical mainnet/devnet USDC mints. Amounts are base units (USDC has 6 decimals). SOL values are lamports. Token recipients' associated token accounts are created if missing; they pay the account rent. Any unsolicited SOL or USDC added to an active escrow is swept to the claimant or refunded creator along with the recorded gift amount.

## Build

This directory is an Anchor workspace alongside the existing Vite app. Use Rust 1.89+ and matching Anchor CLI 1.1.2 / Solana CLI 3.1.x. From the repository root:

```sh
NO_DNA=1 anchor build
```

The `declare_id!` in `src/lib.rs` is Anchor's public example ID used only to let the source compile. Before any deployment, generate a program keypair in a secure local environment, replace the example ID with its public key, and sync `Anchor.toml`. Do not commit the program keypair. The current prototype/serverless escrow remains unchanged until a separately reviewed frontend migration is made.

## Security boundary

- The link is a bearer credential: anyone who obtains the 32-byte preimage can claim. The client must generate it with a cryptographically secure RNG, keep it out of logs and analytics, and share only with the recipient. The preimage becomes public when a claim transaction is submitted; a production design should add recipient-bound authorization before handling valuable funds.
- There is no admin withdrawal path or custody server key in this program.
- The program remains upgradeable according to the deploying program authority. Mainnet use requires independent review and an explicit upgrade-authority policy.
- This is an initial implementation, not an audited or deployed contract. Do not deposit valuable funds until the program has a dedicated test suite, verified build, devnet acceptance flow, and independent security review.
