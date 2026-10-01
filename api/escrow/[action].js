import { neon } from '@neondatabase/serverless'
import bs58 from 'bs58'
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
} from '@solana/web3.js'
import {
  TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction, getAssociatedTokenAddress,
} from '@solana/spl-token'
import { createSecretWordVerifier, verifySecretWord } from '../../lib/secret-word.js'
import { CREATE_SOL_DISCRIMINATOR, CREATE_USDC_DISCRIMINATOR, decodeGiftAccount, giftAddress, SOLGIFT_PROGRAM_ID } from '../../lib/onchain-gift.js'

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
      secret_word_salt text,
      secret_word_hash text,
      secret_attempts integer NOT NULL DEFAULT 0,
      secret_attempt_window timestamptz NOT NULL DEFAULT now(),
      onchain boolean NOT NULL DEFAULT false,
      gift_hash text,
      claim_tx_hash text,
      claim_raw_transaction text,
      claim_blockhash text,
      claim_last_valid_block_height bigint,
      claimed_at timestamptz
    )`
    await sql()`CREATE INDEX IF NOT EXISTS escrow_vouchers_status_created_idx
      ON escrow_vouchers (status, created_at)`
    await sql()`ALTER TABLE escrow_vouchers ADD COLUMN IF NOT EXISTS secret_word_salt text`
    await sql()`ALTER TABLE escrow_vouchers ADD COLUMN IF NOT EXISTS secret_word_hash text`
    await sql()`ALTER TABLE escrow_vouchers ADD COLUMN IF NOT EXISTS secret_attempts integer NOT NULL DEFAULT 0`
    await sql()`ALTER TABLE escrow_vouchers ADD COLUMN IF NOT EXISTS secret_attempt_window timestamptz NOT NULL DEFAULT now()`
    await sql()`ALTER TABLE escrow_vouchers ADD COLUMN IF NOT EXISTS onchain boolean NOT NULL DEFAULT false`
    await sql()`ALTER TABLE escrow_vouchers ADD COLUMN IF NOT EXISTS gift_hash text`
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

async function verifyVoucherSecretPhrase(voucher, secretWord) {
  const attempts = await sql()`UPDATE escrow_vouchers
    SET secret_attempts = CASE WHEN secret_attempt_window < now() - interval '15 minutes' THEN 1 ELSE secret_attempts + 1 END,
        secret_attempt_window = CASE WHEN secret_attempt_window < now() - interval '15 minutes' THEN now() ELSE secret_attempt_window END
    WHERE voucher_id = ${voucher.voucher_id} RETURNING secret_attempts`
  if (!attempts.length || Number(attempts[0].secret_attempts) > 8) {
    throw new Error('Too many secret-word attempts; try again in 15 minutes')
  }
  const pepper = createHmac('sha256', masterKey()).update('solgift:secret-word-pepper:v1').digest()
  if (!await verifySecretWord(secretWord, voucher.secret_word_salt, voucher.secret_word_hash, pepper)) {
    throw new Error('Secret word is incorrect')
  }
}

async function prepare(body) {
  requireDevnet()
  await ensureSchema()
  const voucher = validateVoucher(body)
  const secretWord = await createSecretWordVerifier(body.secretWord, createHmac('sha256', masterKey()).update('solgift:secret-word-pepper:v1').digest())
  const onchain = body.onchain === true
  const escrowSecret = onchain ? randomBytes(32) : Buffer.from(Keypair.generate().secretKey)
  const giftHash = onchain ? createHash('sha256').update(escrowSecret).digest() : null
  const escrowAddress = onchain
    ? giftAddress(voucher.senderAddress, giftHash).toBase58()
    : Keypair.fromSecretKey(escrowSecret).publicKey.toBase58()
  const voucherId = `escrow_${randomBytes(18).toString('base64url')}`
  await sql()`DELETE FROM escrow_vouchers WHERE status = 'prepared' AND created_at < now() - interval '2 hours'`
  await sql()`INSERT INTO escrow_vouchers
    (voucher_id, sender_address, amount, currency, template_id, message, escrow_address, escrow_secret,
      secret_word_salt, secret_word_hash, status, onchain, gift_hash)
    VALUES (${voucherId}, ${voucher.senderAddress}, ${voucher.amount}, ${voucher.currency}, ${voucher.templateId},
      ${voucher.message}, ${escrowAddress}, ${encryptSecret(escrowSecret)},
      ${secretWord.salt}, ${secretWord.verifier}, 'prepared', ${onchain}, ${giftHash ? giftHash.toString('base64url') : null})`
  const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60
  return { escrowAddress, voucherId, giftHash: giftHash?.toString('base64url'), expiresAt, onchain }
}

async function verifyOnchainFunding(voucher, txHash) {
  const tx = await solana().getParsedTransaction(txHash, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
  if (!tx || tx.meta?.err) throw new Error('Funding transaction is not confirmed successfully')
  const giftHash = Buffer.from(voucher.gift_hash, 'base64url')
  const expectedGift = giftAddress(voucher.sender_address, giftHash).toBase58()
  if (expectedGift !== voucher.escrow_address) throw new Error('Gift PDA does not match the prepared gift')
  const signer = tx.transaction.message.accountKeys.some((key) => key.pubkey.toBase58() === voucher.sender_address && key.signer)
  if (!signer) throw new Error('Transaction was not signed by senderAddress')
  const expectedDiscriminator = voucher.currency === 'SOL' ? CREATE_SOL_DISCRIMINATOR : CREATE_USDC_DISCRIMINATOR
  const expectedAmount = amountUnits(voucher.amount, voucher.currency)
  const instruction = tx.transaction.message.instructions.find((item) => item.programId?.equals(SOLGIFT_PROGRAM_ID)
    && item.accounts?.some((account) => account.equals(new PublicKey(expectedGift))))
  if (!instruction) throw new Error('Transaction does not contain the Solgift program instruction')
  const data = bs58.decode(instruction.data)
  if (!data.subarray(0, 8).equals(expectedDiscriminator)
      || !data.subarray(8, 40).equals(giftHash)
      || data.readBigUInt64LE(40) !== expectedAmount) {
    throw new Error('Solgift instruction does not match the prepared gift')
  }
  const gift = decodeGiftAccount(await solana().getAccountInfo(new PublicKey(expectedGift), 'confirmed'))
  if (!gift.giftHash.equals(giftHash) || gift.creator.toBase58() !== voucher.sender_address
      || gift.asset !== voucher.currency || gift.amount !== expectedAmount || gift.status !== 'active') {
    throw new Error('On-chain gift account does not match the prepared voucher')
  }
}

async function verifyFunding(voucher, txHash) {
  if (voucher.onchain) return verifyOnchainFunding(voucher, txHash)
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
  const candidates = body.voucherId
    ? await sql()`SELECT voucher_id, sender_address, amount, currency, template_id, message, escrow_address, onchain, gift_hash, secret_word_salt, secret_word_hash
        FROM escrow_vouchers WHERE voucher_id = ${body.voucherId} AND status = 'prepared'
          AND sender_address = ${fields.senderAddress} AND currency = ${fields.currency}
          AND template_id = ${fields.templateId} AND amount = ${fields.amount} AND message = ${fields.message} LIMIT 1`
    : await sql()`SELECT voucher_id, sender_address, amount, currency, template_id, message, escrow_address, onchain, gift_hash, secret_word_salt, secret_word_hash
        FROM escrow_vouchers WHERE status = 'prepared' AND sender_address = ${fields.senderAddress}
          AND currency = ${fields.currency} AND template_id = ${fields.templateId}
          AND amount = ${fields.amount} AND message = ${fields.message}
        ORDER BY created_at ASC LIMIT 10`
  let selected
  let lastVerificationError
  for (const candidate of candidates) {
    try {
      if (typeof body.secretWord === 'string') await verifyVoucherSecretPhrase(candidate, body.secretWord)
      await verifyFunding(candidate, body.txHash)
      selected = candidate
      break
    } catch (error) { lastVerificationError = error }
  }
  if (!selected) throw lastVerificationError || new Error('No matching prepared escrow intent. Call prepare again.')
  const updated = await sql()`UPDATE escrow_vouchers SET tx_hash = ${body.txHash}, status = 'active', funded_at = now()
    WHERE voucher_id = ${selected.voucher_id} AND status = 'prepared' AND tx_hash IS NULL RETURNING voucher_id`
  if (updated.length) return { status: 'success', voucherId: updated[0].voucher_id }
  const retried = await sql()`SELECT voucher_id FROM escrow_vouchers WHERE tx_hash = ${body.txHash} LIMIT 1`
  if (retried.length) return { status: 'success', voucherId: retried[0].voucher_id }
  throw new Error('Escrow intent has already been used. Call prepare again.')
}

async function recover(body) {
  requireDevnet()
  await ensureSchema()
  if (typeof body.txHash !== 'string' || body.txHash.length < 64 || body.txHash.length > 100) throw new Error('Invalid txHash')
  if (typeof body.secretWord !== 'string') throw new Error('Secret word is required')
  const sender = address(body.senderAddress, 'sender').toBase58()
  const alreadyRegistered = await sql()`SELECT voucher_id, amount, currency, template_id, message
    FROM escrow_vouchers WHERE tx_hash = ${body.txHash} LIMIT 1`
  if (alreadyRegistered.length) return {
    voucherId: alreadyRegistered[0].voucher_id, amount: Number(alreadyRegistered[0].amount),
    currency: alreadyRegistered[0].currency, templateId: alreadyRegistered[0].template_id,
    message: alreadyRegistered[0].message,
  }
  const transaction = await solana().getParsedTransaction(body.txHash, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
  if (!transaction || transaction.meta?.err) throw new Error('Funding transaction is not confirmed successfully')
  const signer = transaction.transaction.message.accountKeys.some((key) => key.pubkey.toBase58() === sender && key.signer)
  if (!signer) throw new Error('Transaction was not signed by senderAddress')
  const instruction = transaction.transaction.message.instructions.find((item) => item.programId?.equals(SOLGIFT_PROGRAM_ID))
  if (!instruction || typeof instruction.data !== 'string') throw new Error('Transaction does not contain the Solgift program instruction')
  const data = bs58.decode(instruction.data)
  const isCreateInstruction = data.subarray(0, 8).equals(CREATE_SOL_DISCRIMINATOR)
    || data.subarray(0, 8).equals(CREATE_USDC_DISCRIMINATOR)
  if (!isCreateInstruction || data.length < 48) throw new Error('Transaction is not a valid gift creation')
  const giftHash = data.subarray(8, 40)
  const escrowAddress = giftAddress(sender, giftHash)
  if (!instruction.accounts?.some((account) => account.equals(escrowAddress))) {
    throw new Error('Gift account does not match the confirmed transaction')
  }
  const candidates = await sql()`SELECT voucher_id, sender_address, amount, currency, template_id, message,
      escrow_address, onchain, gift_hash, secret_word_salt, secret_word_hash
    FROM escrow_vouchers WHERE status = 'prepared' AND onchain = true
      AND sender_address = ${sender} AND escrow_address = ${escrowAddress.toBase58()} LIMIT 1`
  const voucher = candidates[0]
  if (!voucher) throw new Error('No prepared gift matches this transaction. Contact the site operator with the transaction signature.')
  await verifyVoucherSecretPhrase(voucher, body.secretWord)
  await verifyOnchainFunding(voucher, body.txHash)
  const updated = await sql()`UPDATE escrow_vouchers SET tx_hash = ${body.txHash}, status = 'active', funded_at = now()
    WHERE voucher_id = ${voucher.voucher_id} AND status = 'prepared' AND tx_hash IS NULL RETURNING voucher_id`
  if (!updated.length) {
    const retried = await sql()`SELECT voucher_id FROM escrow_vouchers WHERE tx_hash = ${body.txHash} LIMIT 1`
    if (!retried.length) throw new Error('Gift registration changed while recovery was in progress; retry once.')
  }
  return {
    voucherId: voucher.voucher_id, amount: Number(voucher.amount), currency: voucher.currency,
    templateId: voucher.template_id, message: voucher.message,
  }
}

async function details(id) {
  await ensureSchema()
  const rows = await sql()`SELECT voucher_id, sender_address, amount, currency, template_id, message, status, onchain, gift_hash, escrow_address
    FROM escrow_vouchers WHERE voucher_id = ${id} AND status IN ('active', 'claim_preparing', 'claiming', 'claimed') LIMIT 1`
  if (!rows.length) throw new Error('Voucher not found')
  const voucher = rows[0]
  let status = voucher.status === 'claimed' ? 'claimed' : 'active'
  let giftInfo
  if (voucher.onchain) {
    giftInfo = decodeGiftAccount(await solana().getAccountInfo(new PublicKey(voucher.escrow_address), 'confirmed'))
    status = giftInfo.status === 'active' && giftInfo.expiresAt <= Math.floor(Date.now() / 1000) ? 'expired' : giftInfo.status
  }
  return {
    voucherId: voucher.voucher_id, amount: Number(voucher.amount), currency: voucher.currency,
    templateId: voucher.template_id, message: voucher.message, senderAddress: voucher.sender_address,
    giftAddress: voucher.onchain ? voucher.escrow_address : undefined,
    giftHash: voucher.onchain ? voucher.gift_hash : undefined,
    expiresAt: giftInfo?.expiresAt,
    onchain: voucher.onchain, status,
  }
}

async function submitClaim(voucher, recipient) {
  const payout = await signedPayout(voucher, recipient)
  const stored = await sql()`UPDATE escrow_vouchers SET status = 'claiming', claim_tx_hash = ${payout.signature},
    claim_raw_transaction = ${payout.raw.toString('base64')}, claim_blockhash = ${payout.blockhash},
    claim_last_valid_block_height = ${payout.lastValidBlockHeight}
    WHERE voucher_id = ${voucher.voucher_id} AND status = 'claim_preparing' AND recipient_address = ${recipient}
    RETURNING voucher_id`
  if (!stored.length) throw new Error('Voucher claim is no longer reserved')
  return broadcastClaim({ ...voucher, claim_tx_hash: payout.signature, claim_raw_transaction: payout.raw.toString('base64'), claim_blockhash: payout.blockhash, claim_last_valid_block_height: payout.lastValidBlockHeight })
}

async function signedPayout(voucher, recipient) {
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
  return { signature, raw, blockhash, lastValidBlockHeight, receiver: receiver.toBase58() }
}

async function assertFeePayerFunded(voucher, raw) {
  const feePayer = feePayerKeypair()
  const transaction = Transaction.from(raw)
  const estimatedFee = await solana().getFeeForMessage(transaction.compileMessage(), 'confirmed')
  let requiredLamports = estimatedFee.value ?? 5000
  if (voucher.currency === 'USDC') {
    const receiver = new PublicKey(voucher.recipient_address)
    const destinationAta = await getAssociatedTokenAddress(mints[network], receiver, true)
    if (!await solana().getAccountInfo(destinationAta, 'confirmed')) {
      requiredLamports += await solana().getMinimumBalanceForRentExemption(165)
    }
  }
  const balance = await solana().getBalance(feePayer.publicKey, 'confirmed')
  if (balance < requiredLamports) {
    const requiredSol = (requiredLamports / 1e9).toFixed(6)
    const availableSol = (balance / 1e9).toFixed(6)
    const error = new Error(`Devnet fee payer needs at least ${requiredSol} SOL for this payout; current balance is ${availableSol} SOL.`)
    error.code = 'FEE_PAYER_UNFUNDED'
    throw error
  }
}

async function refreshExpiredClaim(voucher) {
  const payout = await signedPayout(voucher, voucher.recipient_address)
  const replacement = await sql()`UPDATE escrow_vouchers SET claim_tx_hash = ${payout.signature},
    claim_raw_transaction = ${payout.raw.toString('base64')}, claim_blockhash = ${payout.blockhash},
    claim_last_valid_block_height = ${payout.lastValidBlockHeight}
    WHERE voucher_id = ${voucher.voucher_id} AND status = 'claiming' AND claim_tx_hash = ${voucher.claim_tx_hash}
    RETURNING voucher_id`
  if (replacement.length) {
    return broadcastClaim({ ...voucher, claim_tx_hash: payout.signature, claim_raw_transaction: payout.raw.toString('base64'), claim_blockhash: payout.blockhash, claim_last_valid_block_height: payout.lastValidBlockHeight })
  }
  const current = await sql()`SELECT * FROM escrow_vouchers WHERE voucher_id = ${voucher.voucher_id} LIMIT 1`
  if (current[0]?.status === 'claiming' && current[0]?.claim_raw_transaction) return broadcastClaim(current[0])
  throw new Error('Voucher claim changed while recovering its expired transaction. Please retry.')
}

async function broadcastClaim(voucher) {
  const signature = voucher.claim_tx_hash
  const raw = Buffer.from(voucher.claim_raw_transaction, 'base64')
  const prior = await solana().getSignatureStatuses([signature], { searchTransactionHistory: true })
  if (prior.value[0]?.err) throw new Error('Payout transaction failed on-chain')
  const confirmed = prior.value[0]?.confirmationStatus === 'confirmed' || prior.value[0]?.confirmationStatus === 'finalized'
  if (!confirmed) {
    if (await solana().getBlockHeight('confirmed') > Number(voucher.claim_last_valid_block_height)) {
      return refreshExpiredClaim(voucher)
    }
    await assertFeePayerFunded(voucher, raw)
    let submittedSignature
    try {
      submittedSignature = await solana().sendRawTransaction(raw, { preflightCommitment: 'confirmed' })
    } catch (error) {
      const expired = /blockhash not found/i.test(error.message || '')
        && await solana().getBlockHeight('confirmed') > Number(voucher.claim_last_valid_block_height)
      if (!expired) throw error
      // Rebuild expired transactions; keeping the old signature would strand the voucher.
      return refreshExpiredClaim(voucher)
    }
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
  if (!voucher.secret_word_salt || !voucher.secret_word_hash) {
    throw new Error('This voucher predates secret-word protection and must be recreated')
  }
  await verifyVoucherSecretPhrase(voucher, body.secretWord)
  if (voucher.onchain) {
    const gift = decodeGiftAccount(await solana().getAccountInfo(new PublicKey(voucher.escrow_address), 'confirmed'))
    if (gift.status !== 'active' || gift.expiresAt <= Math.floor(Date.now() / 1000)) throw new Error('Voucher is no longer claimable')
    return { onchain: true, giftSecret: decryptSecret(voucher.escrow_secret).toString('base64url') }
  }
  if (voucher.status === 'claimed') {
    if (voucher.recipient_address !== recipient) throw new Error('Voucher has already been claimed')
    return { txHash: voucher.claim_tx_hash }
  }
  if (voucher.status === 'claiming' && voucher.claim_raw_transaction) {
    if (voucher.recipient_address !== recipient) throw new Error('Voucher claim is already in progress')
    try { return await broadcastClaim(voucher) } catch (error) {
      if (error.code === 'FEE_PAYER_UNFUNDED') {
        await sql()`UPDATE escrow_vouchers SET status = 'active', recipient_address = NULL,
          claim_tx_hash = NULL, claim_raw_transaction = NULL, claim_blockhash = NULL,
          claim_last_valid_block_height = NULL
          WHERE voucher_id = ${voucher.voucher_id} AND status = 'claiming' AND recipient_address = ${recipient}`
      }
      throw error
    }
  }
  if (voucher.status !== 'active') throw new Error('Voucher is not funded or is no longer claimable')

  const reserved = await sql()`UPDATE escrow_vouchers SET status = 'claim_preparing', recipient_address = ${recipient}
    WHERE voucher_id = ${voucher.voucher_id} AND status = 'active' RETURNING *`
  if (!reserved.length) throw new Error('Voucher claim is already in progress')
  voucher = reserved[0]
  try {
    return await submitClaim(voucher, recipient)
  } catch (error) {
    if (error.code === 'FEE_PAYER_UNFUNDED') {
      await sql()`UPDATE escrow_vouchers SET status = 'active', recipient_address = NULL,
        claim_tx_hash = NULL, claim_raw_transaction = NULL, claim_blockhash = NULL,
        claim_last_valid_block_height = NULL
        WHERE voucher_id = ${voucher.voucher_id} AND status IN ('claim_preparing', 'claiming') AND recipient_address = ${recipient}`
    } else {
      await sql()`UPDATE escrow_vouchers SET status = 'active', recipient_address = NULL
        WHERE voucher_id = ${voucher.voucher_id} AND status = 'claim_preparing'`
    }
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

function isAllowedOrigin(request, origin) {
  if (!origin || allowedOrigins.has(origin)) return true
  const protocol = (request.headers['x-forwarded-proto'] || (request.socket?.encrypted ? 'https' : 'http')).split(',')[0].trim()
  const host = request.headers['x-forwarded-host'] || request.headers.host
  return Boolean(host && origin === `${protocol}://${host}`)
}

export default async function handler(request, response) {
  const origin = request.headers.origin
  if (request.method === 'OPTIONS') return send(response, 204, {}, isAllowedOrigin(request, origin) ? origin : undefined)
  if (!isAllowedOrigin(request, origin)) return send(response, 403, { message: 'Origin is not allowed' })
  const routeOrigin = origin && isAllowedOrigin(request, origin) ? origin : undefined
  const action = request.query?.action
  try {
    if (request.method === 'GET' && action === 'health') {
      await ensureSchema()
      const feePayer = feePayerKeypair()
      const feePayerBalanceLamports = await solana().getBalance(feePayer.publicKey, 'confirmed')
      return send(response, 200, {
        status: 'ok', network, feePayerConfigured: true,
        feePayerAddress: feePayer.publicKey.toBase58(), feePayerBalanceLamports,
      }, routeOrigin)
    }
    if (request.method === 'POST' && action === 'prepare') return send(response, 200, await prepare(request.body || {}), routeOrigin)
    if (request.method === 'POST' && action === 'create') return send(response, 200, await create(request.body || {}), routeOrigin)
    if (request.method === 'POST' && action === 'recover') return send(response, 200, await recover(request.body || {}), routeOrigin)
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
    const status = error.code === 'FEE_PAYER_UNFUNDED' ? 503
      : /too many secret-word attempts/i.test(message) ? 429
      : /secret word is incorrect/i.test(message) ? 401
      : /not found/i.test(message) ? 404
      : /already|in progress|claimable|reserved|predates secret-word/i.test(message) ? 409
        : /^(Invalid |Amount |Currency |Unknown |Message |Secret phrase|Secret word is required|Transaction |Funding transaction |No matching |Voucher )/.test(message) ? 400 : 500
    return send(response, status, { status: 'error', message }, routeOrigin)
  }
}
