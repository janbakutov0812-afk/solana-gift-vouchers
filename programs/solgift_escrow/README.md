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
NO_DNA=1 anchor build --no-idl -- --arch v0
NO_DNA=1 anchor idl build --out target/idl/solgift_escrow.json --out-ts target/types/solgift_escrow.ts
```

The explicit `v0` target matches this program's Solana 3.1 dependencies. The current Anchor CLI defaults to `v3`, which does not support the unresolved syscall symbols emitted by these dependencies. Build the SBF binary and IDL in separate commands because Anchor forwards build arguments to the IDL test step too.

## Devnet deployment

Deployment uses a local fee-payer and upgrade-authority key at `~/.config/solana/id.json`. Keep that key private and out of Git. The Vercel API fee-payer is a separate server-side key and cannot sign this deployment. The 275,288-byte program binary needs about 1.40 Devnet SOL for rent exemption; keep at least 2 Devnet SOL in the local deploy wallet for rent and fees.

```sh
solana config set --url devnet
solana-keygen new --outfile ~/.config/solana/id.json # only if this wallet file does not exist
solana address
solana balance
NO_DNA=1 anchor deploy --provider.cluster devnet --provider.wallet ~/.config/solana/id.json
```

The program ID and matching deploy keypair have been generated for this checkout. The keypair is stored at `target/deploy/solgift_escrow-keypair.json` (ignored by Git); keep it backed up securely and never commit or share it. Rebuild the program with this keypair before deployment. The current website/API now requires a separately shared secret phrase, but that check is not part of this Anchor program. The claim instructions below still use bearer-secret authorization; add and review an authorized claim flow before connecting the website or deploying this contract.

## Security boundary

- The link is a bearer credential: anyone who obtains the 32-byte preimage can claim. The client must generate it with a cryptographically secure RNG, keep it out of logs and analytics, and share only with the recipient. The preimage becomes public when a claim transaction is submitted; a production design should add recipient-bound authorization before handling valuable funds.
- There is no admin withdrawal path or custody server key in this program.
- The program remains upgradeable according to the deploying program authority. Mainnet use requires independent review and an explicit upgrade-authority policy.
- This is an initial implementation, not an audited or deployed contract. Do not deposit valuable funds until the program has a dedicated test suite, verified build, devnet acceptance flow, and independent security review.
