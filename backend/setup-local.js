import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { Keypair } from '@solana/web3.js'

const envPath = new URL('../.env.local', import.meta.url)
if (existsSync(envPath)) {
  console.error('.env.local already exists. It was left untouched; remove it only if you intend to rotate the local devnet keys.')
  process.exit(1)
}

const feePayer = Keypair.generate()
const content = [
  'VITE_SOLANA_NETWORK=devnet',
  'VITE_SOLANA_RPC_URL=https://api.devnet.solana.com',
  'VITE_VOUCHER_API_URL=http://localhost:8787',
  'ESCROW_NETWORK=devnet',
  'ESCROW_HOST=127.0.0.1',
  'ESCROW_PORT=8787',
  'ESCROW_ALLOWED_ORIGIN=http://localhost:5173',
  `ESCROW_MASTER_KEY=${randomBytes(32).toString('hex')}`,
  `ESCROW_FEE_PAYER_SECRET_KEY=${JSON.stringify([...feePayer.secretKey])}`,
  '',
].join('\n')
await writeFile(envPath, content, { mode: 0o600, flag: 'wx' })
console.log('Created ignored .env.local for devnet.')
console.log(`Local fee payer address: ${feePayer.publicKey.toBase58()}`)
