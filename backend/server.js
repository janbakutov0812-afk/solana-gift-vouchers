import { createServer } from 'node:http'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import bs58 from 'bs58'
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
} from '@solana/web3.js'
import {
  TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction, getAssociatedTokenAddress,
} from '@solana/spl-token'

const here = path.dirname(fileURLToPath(import.meta.url))
const databasePath = process.env.ESCROW_DB_PATH || path.join(here, 'data', 'vouchers.json')
const port = Number(process.env.PORT || process.env.ESCROW_PORT || 8787)
const host = process.env.ESCROW_HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1')
const network = process.env.ESCROW_NETWORK || process.env.VITE_SOLANA_NETWORK || 'devnet'
const rpcUrl = process.env.ESCROW_RPC_URL || process.env.VITE_SOLANA_RPC_URL || 'https://api.devnet.solana.com'
const allowedOrigins = new Set((process.env.ESCROW_ALLOWED_ORIGINS || process.env.ESCROW_ALLOWED_ORIGIN || 'http://localhost:5173')
  .split(',').map((origin) => origin.trim()).filter(Boolean))
const encryptionKey = Buffer.from(process.env.ESCROW_MASTER_KEY || '', 'hex')
const feePayerBytes = JSON.parse(process.env.ESCROW_FEE_PAYER_SECRET_KEY || '[]')
const feePayer = Keypair.fromSecretKey(Uint8Array.from(feePayerBytes))
const connection = new Connection(rpcUrl, 'confirmed')
const templates = new Set(['birthday', 'coffee', 'thanks', 'study'])
const mints = {
  devnet: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
  'mainnet-beta': new PublicKey('EPjFWdd5AufqSSqeM2q2xzybapC8G4wEGGkZwyTDt1v'),
}

if (network !== 'devnet') throw new Error('This local escrow server is devnet-only.')
if (encryptionKey.length !== 32) throw new Error('ESCROW_MASTER_KEY must be 32 bytes encoded as hex.')
if (feePayer.secretKey.length !== 64) throw new Error('ESCROW_FEE_PAYER_SECRET_KEY must be a JSON byte array.')

let database = { vouchers: [] }
let writeQueue = Promise.resolve()
const activeClaims = new Set()

function encryptSecret(secretKey) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv)
  const encrypted = Buffer.concat([cipher.update(secretKey), cipher.final()])
  return { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: encrypted.toString('hex') }
}

function decryptSecret(value) {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(value.iv, 'hex'))
  decipher.setAuthTag(Buffer.from(value.tag, 'hex'))
  return Buffer.concat([decipher.update(Buffer.from(value.data, 'hex')), decipher.final()])
}

function persist() {
  writeQueue = writeQueue.then(async () => {
    await mkdir(path.dirname(databasePath), { recursive: true, mode: 0o700 })
    const temporaryPath = `${databasePath}.tmp`
    await writeFile(temporaryPath, JSON.stringify(database, null, 2), { mode: 0o600 })
    await rename(temporaryPath, databasePath)
  })
  return writeQueue
}

function json(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': response.allowedOrigin || [...allowedOrigins][0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

async function readBody(request) {
  let input = ''
  for await (const part of request) {
    input += part
    if (input.length > 16_384) throw new Error('Request body is too large')
  }
  return JSON.parse(input || '{}')
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

function findVoucher(id) {
  return database.vouchers.find((voucher) => voucher.voucherId === id)
}

async function prepare(body) {
  const sender = address(body.senderAddress, 'sender')
  if (!['SOL', 'USDC'].includes(body.currency)) throw new Error('Currency must be SOL or USDC')
  const amount = Number(amountUnits(body.amount, body.currency)) / (body.currency === 'SOL' ? 1e9 : 1e6)
  if (!templates.has(body.templateId)) throw new Error('Unknown templateId')
  if (typeof body.message !== 'string' || body.message.length > 120) throw new Error('Message must be 120 characters or fewer')

  const now = Date.now()
  database.vouchers = database.vouchers.filter((voucher) => voucher.status !== 'prepared'
    || now - Date.parse(voucher.createdAt) < 2 * 60 * 60 * 1000)
  const escrow = Keypair.generate()
  const voucherId = `escrow_${randomBytes(18).toString('base64url')}`
  database.vouchers.push({
    voucherId, senderAddress: sender.toBase58(), amount, currency: body.currency,
    templateId: body.templateId, message: body.message, escrowAddress: escrow.publicKey.toBase58(),
    escrowSecret: encryptSecret(Buffer.from(escrow.secretKey)), status: 'prepared',
    createdAt: new Date().toISOString(),
  })
  await persist()
  return { escrowAddress: escrow.publicKey.toBase58() }
}

async function verifyFunding(voucher, txHash, body) {
  const tx = await connection.getParsedTransaction(txHash, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
  if (!tx || tx.meta?.err) throw new Error('Funding transaction is not confirmed successfully')
  const sender = voucher.senderAddress
  const escrow = new PublicKey(voucher.escrowAddress)
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
  } else {
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
}

async function create(body) {
  if (typeof body.txHash !== 'string' || body.txHash.length < 64 || body.txHash.length > 100) throw new Error('Invalid txHash')
  const duplicate = database.vouchers.find((voucher) => voucher.txHash === body.txHash)
  if (duplicate) return { status: 'success', voucherId: duplicate.voucherId }
  if (!['SOL', 'USDC'].includes(body.currency)) throw new Error('Currency must be SOL or USDC')
  const decimals = body.currency === 'SOL' ? 1e9 : 1e6
  const expectedAmount = Number(amountUnits(body.amount, body.currency)) / decimals
  const candidates = database.vouchers.filter((item) => item.status === 'prepared'
    && item.senderAddress === body.senderAddress && item.currency === body.currency
    && item.templateId === body.templateId && item.amount === expectedAmount && item.message === body.message)
  if (!candidates.length) throw new Error('No matching prepared escrow intent. Call prepare again.')
  let voucher
  let lastVerificationError
  for (const candidate of candidates) {
    try {
      await verifyFunding(candidate, body.txHash, body)
      voucher = candidate
      break
    } catch (error) { lastVerificationError = error }
  }
  if (!voucher) throw lastVerificationError || new Error('Funding transaction did not match a prepared intent')
  voucher.txHash = body.txHash
  voucher.status = 'active'
  voucher.fundedAt = new Date().toISOString()
  await persist()
  return { status: 'success', voucherId: voucher.voucherId }
}

async function details(id) {
  const voucher = findVoucher(id)
  if (!voucher || !['active', 'claiming', 'claimed'].includes(voucher.status)) throw new Error('Voucher not found')
  return {
    voucherId: voucher.voucherId, amount: voucher.amount, currency: voucher.currency,
    templateId: voucher.templateId, message: voucher.message,
    status: voucher.status === 'claimed' ? 'claimed' : 'active',
  }
}

async function submitClaim(voucher, recipient) {
  const escrow = Keypair.fromSecretKey(decryptSecret(voucher.escrowSecret))
  const receiver = address(recipient, 'recipient')
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
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
  voucher.status = 'claiming'
  voucher.recipientAddress = receiver.toBase58()
  voucher.claimTxHash = signature
  voucher.claimRawTransaction = raw.toString('base64')
  voucher.claimBlockhash = blockhash
  voucher.claimLastValidBlockHeight = lastValidBlockHeight
  await persist()
  return broadcastClaim(voucher)
}

async function broadcastClaim(voucher) {
  const signature = voucher.claimTxHash
  const raw = Buffer.from(voucher.claimRawTransaction, 'base64')
  const prior = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })
  if (prior.value[0]?.err) throw new Error('Payout transaction failed on-chain')
  if (!prior.value[0] || prior.value[0].confirmationStatus !== 'confirmed' && prior.value[0].confirmationStatus !== 'finalized') {
    const submittedSignature = await connection.sendRawTransaction(raw, { preflightCommitment: 'confirmed' })
    const confirmation = await connection.confirmTransaction({
      signature: submittedSignature, blockhash: voucher.claimBlockhash,
      lastValidBlockHeight: voucher.claimLastValidBlockHeight,
    }, 'confirmed')
    if (confirmation.value.err) throw new Error('Payout transaction failed on-chain')
  }
  voucher.status = 'claimed'
  voucher.claimedAt = new Date().toISOString()
  delete voucher.claimRawTransaction
  delete voucher.claimBlockhash
  delete voucher.claimLastValidBlockHeight
  await persist()
  return { txHash: signature }
}

async function claim(body) {
  if (typeof body.voucherId !== 'string') throw new Error('Invalid voucherId')
  const voucher = findVoucher(body.voucherId)
  if (!voucher) throw new Error('Voucher not found')
  const recipient = address(body.recipientAddress, 'recipient').toBase58()
  if (activeClaims.has(voucher.voucherId)) throw new Error('Voucher claim is already in progress')
  activeClaims.add(voucher.voucherId)
  try {
    if (voucher.status === 'claimed') {
      if (voucher.recipientAddress !== recipient) throw new Error('Voucher has already been claimed')
      return { txHash: voucher.claimTxHash }
    }
    if (voucher.status === 'claiming' && voucher.claimRawTransaction) {
      if (voucher.recipientAddress !== recipient) throw new Error('Voucher claim is already in progress')
      return broadcastClaim(voucher)
    }
    if (voucher.status !== 'active') throw new Error('Voucher is not funded or is no longer claimable')
    voucher.status = 'claim_preparing'
    voucher.recipientAddress = recipient
    await persist()
    try {
      return await submitClaim(voucher, recipient)
    } catch (error) {
      if (voucher.status === 'claim_preparing') {
        voucher.status = 'active'
        delete voucher.recipientAddress
        await persist()
      }
      throw error
    }
  } finally {
    activeClaims.delete(voucher.voucherId)
  }
}

async function handle(request, response) {
  if (request.method === 'OPTIONS') return json(response, 204, {})
  const origin = request.headers.origin
  if (origin && !allowedOrigins.has(origin)) return json(response, 403, { message: 'Origin is not allowed' })
  response.allowedOrigin = origin || [...allowedOrigins][0]
  try {
    const url = new URL(request.url, `http://${host}:${port}`)
    if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { status: 'ok', network })
    if (request.method === 'POST' && url.pathname === '/api/escrow/prepare') return json(response, 200, await prepare(await readBody(request)))
    if (request.method === 'POST' && url.pathname === '/api/escrow/create') return json(response, 200, await create(await readBody(request)))
    if (request.method === 'GET' && url.pathname === '/api/escrow/details') {
      const id = url.searchParams.get('id')
      if (!id || !/^escrow_[A-Za-z0-9_-]{1,64}$/.test(id)) return json(response, 400, { message: 'Invalid voucher ID' })
      return json(response, 200, await details(id))
    }
    if (request.method === 'POST' && url.pathname === '/api/escrow/claim') return json(response, 200, await claim(await readBody(request)))
    return json(response, 404, { message: 'Endpoint not found' })
  } catch (error) {
    const message = error instanceof SyntaxError ? 'Invalid JSON request body' : error.message || 'Unexpected server error'
    const status = /not found/i.test(message) ? 404 : /already|in progress|claimable/i.test(message) ? 409 : 400
    return json(response, status, { status: 'error', message })
  }
}

async function start() {
  try {
    const saved = JSON.parse(await readFile(databasePath, 'utf8'))
    if (Array.isArray(saved.vouchers)) database = saved
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  let resetClaims = false
  for (const voucher of database.vouchers) {
    if (voucher.status === 'claim_preparing') {
      voucher.status = 'active'
      delete voucher.recipientAddress
      resetClaims = true
    }
  }
  if (resetClaims) await persist()
  createServer((request, response) => void handle(request, response)).listen(port, host, () => {
    console.log(`Local devnet Escrow API listening at http://${host}:${port}`)
    console.log(`Fee payer: ${feePayer.publicKey.toBase58()}`)
  })
}

start().catch((error) => { console.error(error); process.exitCode = 1 })
