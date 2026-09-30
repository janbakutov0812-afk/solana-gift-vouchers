import { neon } from '@neondatabase/serverless'
import bs58 from 'bs58'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
} from '@solana/web3.js'
import {
  TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction, getAssociatedTokenAddress,
} from '@solana/spl-token'

const templates = new Set(['birthday', 'coffee', 'thanks', 'study'])
const network = process.env.ESCROW_NETWORK || 'devnet'
const rpcUrl = process.env.ESCROW_RPC_URL || 'https://api.devnet.solana.com'
const allowedOrigins = new Set((process.env.ESCROW_ALLOWED_ORIGINS || '')
  .split(',').map((origin) => origin.trim()).filter(Boolean))
const mints = {
  devnet: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
}

let sqlClient
let schemaReady
let connection

function sql() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured')
  sqlClient ||= neon(process.env.DATABASE_URL)
  return sqlClient
}

async function ensureSchema() {
  schemaReady ||= (async () => {
    await sql()`CREATE TABLE IF NOT EXISTS escrow_vouchers (
      voucher_id text PRIMARY KEY,
      sender_address text NOT NULL,
      amount numeric(30, 9) NOT NULL,
      currency text NOT NULL CHECK (currency IN ('SOL', 'USDC')),
      template_id text NOT NULL,
      message text NOT NULL,
      escrow_address text NOT NULL UNIQUE,
      escrow_secret text NOT NULL,
      status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      funded_at timestamptz,
      tx_hash text UNIQUE,
      recipient_address text,
      claim_tx_hash text,
      claim_raw_transaction text,
      claim_blockhash text,
      claim_last_valid_block_height bigint,
      claimed_at timestamptz
    )`
    await sql()`CREATE INDEX IF NOT EXISTS escrow_vouchers_status_created_idx
      ON escrow_vouchers (status, created_at)`
  })().catch((error) => { schemaReady = undefined; throw error })
  return schemaReady
}

function solana() {
  connection ||= new Connection(rpcUrl, 'confirmed')
  return connection
}

function requireDevnet() {
  if (network !== 'devnet') throw new Error('This escrow API is devnet-only.')
}

function masterKey() {
  const key = Buffer.from(process.env.ESCROW_MASTER_KEY || '', 'hex')
  if (key.length !== 32) throw new Error('ESCROW_MASTER_KEY must be 32 bytes encoded as hex.')
  return key
}

function feePayerKeypair() {
  const secret = (process.env.ESCROW_FEE_PAYER_SECRET_KEY || '').trim()
  let bytes
  if (secret.startsWith('[') || secret.startsWith('"')) {
    try {
      bytes = JSON.parse(secret)
      if (typeof bytes === 'string') bytes = JSON.parse(bytes)
    } catch {
      throw new Error('ESCROW_FEE_PAYER_SECRET_KEY must be base58 or a JSON byte array.')
    }
    if (!Array.isArray(bytes) || bytes.length !== 64 || bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      throw new Error('ESCROW_FEE_PAYER_SECRET_KEY must contain exactly 64 secret bytes.')
    }
    bytes = Uint8Array.from(bytes)
  } else {
    try { bytes = bs58.decode(secret) } catch {
      throw new Error('ESCROW_FEE_PAYER_SECRET_KEY must be base58 or a JSON byte array.')
    }
    if (bytes.length !== 64) throw new Error('ESCROW_FEE_PAYER_SECRET_KEY must contain exactly 64 secret bytes.')
  }
  return Keypair.fromSecretKey(bytes)
}

function encryptSecret(secretKey) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv)
  const encrypted = Buffer.concat([cipher.update(secretKey), cipher.final()])
  return JSON.stringify({ iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: encrypted.toString('hex') })
}

function decryptSecret(value) {
  const encrypted = JSON.parse(value)
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(encrypted.iv, 'hex'))
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'hex'))
  return Buffer.concat([decipher.update(Buffer.from(encrypted.data, 'hex')), decipher.final()])
}

function address(value, name) {
  try { return new PublicKey(value) } catch { throw new Error(`Invalid ${name} address`) }
}

function amountUnits(amount, currency) {
  const decimals = currency === 'SOL' ? 9 : 6
  const numeric = Number(amount)
  if (!Number.isFinite(numeric) || numeric <= 0) throw new Error('Amount must be a positive number')
  const units = Math.round(numeric * 10 ** decimals)
  if (!Number.isSafeInteger(units) || units <= 0) throw new Error('Amount is outside the supported range')
  return BigInt(units)
}

function validateVoucher(body) {
  const sender = address(body.senderAddress, 'sender')
  if (!['SOL', 'USDC'].includes(body.currency)) throw new Error('Currency must be SOL or USDC')
  const divisor = body.currency === 'SOL' ? 1e9 : 1e6
  const amount = Number(amountUnits(body.amount, body.currency)) / divisor
  if (!templates.has(body.templateId)) throw new Error('Unknown templateId')
  if (typeof body.message !== 'string' || body.message.length > 120) throw new Error('Message must be 120 characters or fewer')
  return { senderAddress: sender.toBase58(), amount, currency: body.currency, templateId: body.templateId, message: body.message }
}

async function prepare(body) {
  requireDevnet()
  await ensureSchema()
  const voucher = validateVoucher(body)
  const escrow = Keypair.generate()
  const voucherId = `escrow_${randomBytes(18).toString('base64url')}`
  await sql()`DELETE FROM escrow_vouchers WHERE status = 'prepared' AND created_at < now() - interval '2 hours'`
  await sql()`INSERT INTO escrow_vouchers
    (voucher_id, sender_address, amount, currency, template_id, message, escrow_address, escrow_secret, status)
    VALUES (${voucherId}, ${voucher.senderAddress}, ${voucher.amount}, ${voucher.currency}, ${voucher.templateId},
      ${voucher.message}, ${escrow.publicKey.toBase58()}, ${encryptSecret(Buffer.from(escrow.secretKey))}, 'prepared')`
  return { escrowAddress: escrow.publicKey.toBase58() }
}

async function verifyFunding(voucher, txHash) {
  const tx = await solana().getParsedTransaction(txHash, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
  if (!tx || tx.meta?.err) throw new Error('Funding transaction is not confirmed successfully')
  const sender = voucher.sender_address
  const escrow = new PublicKey(voucher.escrow_address)
  const signer = tx.transaction.message.accountKeys.some((key) => key.pubkey.toBase58() === sender && key.signer)
  if (!signer) throw new Error('Transaction was not signed by senderAddress')

  const instructions = tx.transaction.message.instructions
  if (voucher.currency === 'SOL') {
    const expected = Number(amountUnits(voucher.amount, 'SOL'))
    const valid = instructions.some((instruction) => instruction.program === 'system'
      && instruction.parsed?.type === 'transfer'
      && instruction.parsed.info.source === sender
      && instruction.parsed.info.destination === escrow.toBase58()
      && Number(instruction.parsed.info.lamports) === expected)
    if (!valid) throw new Error('Transaction does not contain the expected SOL escrow transfer')
    return
  }

  const mint = mints[network]
  const sourceAta = await getAssociatedTokenAddress(mint, new PublicKey(sender))
  const escrowAta = await getAssociatedTokenAddress(mint, escrow)
  const expected = amountUnits(voucher.amount, 'USDC').toString()
  const valid = instructions.some((instruction) => {
    const info = instruction.parsed?.info
    if (instruction.program !== 'spl-token' || !['transfer', 'transferChecked'].includes(instruction.parsed?.type)) return false
    const units = info?.tokenAmount?.amount ?? info?.amount
    return info?.authority === sender && info?.source === sourceAta.toBase58()
      && info?.destination === escrowAta.toBase58() && String(units) === expected
      && (!info?.mint || info.mint === mint.toBase58())
  })
  if (!valid) throw new Error('Transaction does not contain the expected USDC escrow transfer')
}

async function create(body) {
  requireDevnet()
  await ensureSchema()
  if (typeof body.txHash !== 'string' || body.txHash.length < 64 || body.txHash.length > 100) throw new Error('Invalid txHash')
  const duplicate = await sql()`SELECT voucher_id FROM escrow_vouchers WHERE tx_hash = ${body.txHash} LIMIT 1`
  if (duplicate.length) return { status: 'success', voucherId: duplicate[0].voucher_id }
  const fields = validateVoucher(body)
  const candidates = await sql()`SELECT voucher_id, sender_address, amount, currency, template_id, message, escrow_address
    FROM escrow_vouchers WHERE status = 'prepared' AND sender_address = ${fields.senderAddress}
      AND currency = ${fields.currency} AND template_id = ${fields.templateId}
      AND amount = ${fields.amount} AND message = ${fields.message}
    ORDER BY created_at ASC LIMIT 10`
  let selected
  let lastVerificationError
  for (const candidate of candidates) {
    try { await verifyFunding(candidate, body.txHash); selected = candidate; break } catch (error) { lastVerificationError = error }
  }
  if (!selected) throw lastVerificationError || new Error('No matching prepared escrow intent. Call prepare again.')
  const updated = await sql()`UPDATE escrow_vouchers SET tx_hash = ${body.txHash}, status = 'active', funded_at = now()
    WHERE voucher_id = ${selected.voucher_id} AND status = 'prepared' AND tx_hash IS NULL RETURNING voucher_id`
  if (updated.length) return { status: 'success', voucherId: updated[0].voucher_id }
  const retried = await sql()`SELECT voucher_id FROM escrow_vouchers WHERE tx_hash = ${body.txHash} LIMIT 1`
  if (retried.length) return { status: 'success', voucherId: retried[0].voucher_id }
  throw new Error('Escrow intent has already been used. Call prepare again.')
}

async function details(id) {
  await ensureSchema()
  const rows = await sql()`SELECT voucher_id, amount, currency, template_id, message, status
    FROM escrow_vouchers WHERE voucher_id = ${id} AND status IN ('active', 'claim_preparing', 'claiming', 'claimed') LIMIT 1`
  if (!rows.length) throw new Error('Voucher not found')
  const voucher = rows[0]
  return {
    voucherId: voucher.voucher_id, amount: Number(voucher.amount), currency: voucher.currency,
    templateId: voucher.template_id, message: voucher.message,
    status: voucher.status === 'claimed' ? 'claimed' : 'active',
  }
}

async function submitClaim(voucher, recipient) {
  const escrow = Keypair.fromSecretKey(decryptSecret(voucher.escrow_secret))
  const receiver = address(recipient, 'recipient')
  const feePayer = feePayerKeypair()
  const { blockhash, lastValidBlockHeight } = await solana().getLatestBlockhash('confirmed')
  const transaction = new Transaction({ feePayer: feePayer.publicKey, recentBlockhash: blockhash })

  if (voucher.currency === 'SOL') {
    transaction.add(SystemProgram.transfer({
      fromPubkey: escrow.publicKey, toPubkey: receiver,
      lamports: Number(amountUnits(voucher.amount, 'SOL')),
    }))
  } else {
    const mint = mints[network]
    const sourceAta = await getAssociatedTokenAddress(mint, escrow.publicKey)
    const destinationAta = await getAssociatedTokenAddress(mint, receiver, true)
    transaction.add(createAssociatedTokenAccountIdempotentInstruction(
      feePayer.publicKey, destinationAta, receiver, mint, TOKEN_PROGRAM_ID,
    ))
    transaction.add(createTransferCheckedInstruction(
      sourceAta, mint, destinationAta, escrow.publicKey,
      Number(amountUnits(voucher.amount, 'USDC')), 6, [], TOKEN_PROGRAM_ID,
    ))
  }

  transaction.partialSign(escrow, feePayer)
  const raw = transaction.serialize()
  const signature = bs58.encode(transaction.signature)
  const stored = await sql()`UPDATE escrow_vouchers SET status = 'claiming', claim_tx_hash = ${signature},
    claim_raw_transaction = ${raw.toString('base64')}, claim_blockhash = ${blockhash},
    claim_last_valid_block_height = ${lastValidBlockHeight}
    WHERE voucher_id = ${voucher.voucher_id} AND status = 'claim_preparing' AND recipient_address = ${receiver.toBase58()}
    RETURNING voucher_id`
  if (!stored.length) throw new Error('Voucher claim is no longer reserved')
  return broadcastClaim({ ...voucher, claim_tx_hash: signature, claim_raw_transaction: raw.toString('base64'), claim_blockhash: blockhash, claim_last_valid_block_height: lastValidBlockHeight })
}

async function broadcastClaim(voucher) {
  const signature = voucher.claim_tx_hash
  const raw = Buffer.from(voucher.claim_raw_transaction, 'base64')
  const prior = await solana().getSignatureStatuses([signature], { searchTransactionHistory: true })
  if (prior.value[0]?.err) throw new Error('Payout transaction failed on-chain')
  const confirmed = prior.value[0]?.confirmationStatus === 'confirmed' || prior.value[0]?.confirmationStatus === 'finalized'
  if (!confirmed) {
    const submittedSignature = await solana().sendRawTransaction(raw, { preflightCommitment: 'confirmed' })
    const confirmation = await solana().confirmTransaction({
      signature: submittedSignature, blockhash: voucher.claim_blockhash,
      lastValidBlockHeight: Number(voucher.claim_last_valid_block_height),
    }, 'confirmed')
    if (confirmation.value.err) throw new Error('Payout transaction failed on-chain')
  }
  await sql()`UPDATE escrow_vouchers SET status = 'claimed', claimed_at = now(),
    claim_raw_transaction = NULL, claim_blockhash = NULL, claim_last_valid_block_height = NULL
    WHERE voucher_id = ${voucher.voucher_id} AND status = 'claiming'`
  return { txHash: signature }
}

async function claim(body) {
  requireDevnet()
  await ensureSchema()
  if (typeof body.voucherId !== 'string') throw new Error('Invalid voucherId')
  const recipient = address(body.recipientAddress, 'recipient').toBase58()
  const rows = await sql()`SELECT * FROM escrow_vouchers WHERE voucher_id = ${body.voucherId} LIMIT 1`
  if (!rows.length) throw new Error('Voucher not found')
  let voucher = rows[0]
  if (voucher.status === 'claimed') {
    if (voucher.recipient_address !== recipient) throw new Error('Voucher has already been claimed')
    return { txHash: voucher.claim_tx_hash }
  }
  if (voucher.status === 'claiming' && voucher.claim_raw_transaction) {
    if (voucher.recipient_address !== recipient) throw new Error('Voucher claim is already in progress')
    return broadcastClaim(voucher)
  }
  if (voucher.status !== 'active') throw new Error('Voucher is not funded or is no longer claimable')

  const reserved = await sql()`UPDATE escrow_vouchers SET status = 'claim_preparing', recipient_address = ${recipient}
    WHERE voucher_id = ${voucher.voucher_id} AND status = 'active' RETURNING *`
  if (!reserved.length) throw new Error('Voucher claim is already in progress')
  voucher = reserved[0]
  try {
    return await submitClaim(voucher, recipient)
  } catch (error) {
    await sql()`UPDATE escrow_vouchers SET status = 'active', recipient_address = NULL
      WHERE voucher_id = ${voucher.voucher_id} AND status = 'claim_preparing'`
    throw error
  }
}

function send(response, status, payload, origin) {
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Vary', 'Origin')
  if (origin) response.setHeader('Access-Control-Allow-Origin', origin)
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  response.status(status).json(payload)
}

export default async function handler(request, response) {
  const origin = request.headers.origin
  if (request.method === 'OPTIONS') return send(response, 204, {}, allowedOrigins.has(origin) ? origin : undefined)
  if (origin && !allowedOrigins.has(origin)) return send(response, 403, { message: 'Origin is not allowed' })
  const routeOrigin = origin && allowedOrigins.has(origin) ? origin : undefined
  const action = request.query?.action
  try {
    if (request.method === 'GET' && action === 'health') {
      await ensureSchema()
      const feePayer = feePayerKeypair()
      const feePayerBalanceLamports = await solana().getBalance(feePayer.publicKey, 'confirmed')
      return send(response, 200, { status: 'ok', network, feePayerConfigured: true, feePayerBalanceLamports }, routeOrigin)
    }
    if (request.method === 'POST' && action === 'prepare') return send(response, 200, await prepare(request.body || {}), routeOrigin)
    if (request.method === 'POST' && action === 'create') return send(response, 200, await create(request.body || {}), routeOrigin)
    if (request.method === 'GET' && action === 'details') {
      const id = typeof request.query?.id === 'string' ? request.query.id : ''
      if (!/^escrow_[A-Za-z0-9_-]{1,64}$/.test(id)) return send(response, 400, { message: 'Invalid voucher ID' }, routeOrigin)
      return send(response, 200, await details(id), routeOrigin)
    }
    if (request.method === 'POST' && action === 'claim') return send(response, 200, await claim(request.body || {}), routeOrigin)
    if (!['GET', 'POST', 'OPTIONS'].includes(request.method)) return send(response, 405, { message: 'Method not allowed' }, routeOrigin)
    return send(response, 404, { message: 'Endpoint not found' }, routeOrigin)
  } catch (error) {
    console.error('Escrow API error:', error)
    const message = error instanceof SyntaxError ? 'Invalid request body' : error.message || 'Unexpected server error'
    const status = /not found/i.test(message) ? 404
      : /already|in progress|claimable|reserved/i.test(message) ? 409
        : /^(Invalid |Amount |Currency |Unknown |Message |Transaction |Funding transaction |No matching |Voucher )/.test(message) ? 400 : 500
    return send(response, status, { status: 'error', message }, routeOrigin)
  }
}
