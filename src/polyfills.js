import { Buffer } from 'buffer'

// Solana SPL helpers use the Node Buffer API in browser bundles.
globalThis.Buffer ??= Buffer
