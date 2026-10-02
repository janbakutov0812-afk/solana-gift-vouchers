import { createHash } from 'node:crypto'
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddress,
} from '@solana/spl-token'

export const SOLGIFT_PROGRAM_ID = new PublicKey('A5cFtpUVnBncPqaBpUjHUtb9brk3qoPZSUjRdD3DTht2')
export const GIFT_ACCOUNT_DISCRIMINATOR = createHash('sha256').update('account:Gift').digest().subarray(0, 8)
export const CREATE_SOL_DISCRIMINATOR = createHash('sha256').update('global:create_sol_gift').digest().subarray(0, 8)
export const CREATE_USDC_DISCRIMINATOR = createHash('sha256').update('global:create_usdc_gift').digest().subarray(0, 8)
export const CLAIM_SOL_DISCRIMINATOR = createHash('sha256').update('global:claim_sol_gift').digest().subarray(0, 8)
export const CLAIM_USDC_DISCRIMINATOR = createHash('sha256').update('global:claim_usdc_gift').digest().subarray(0, 8)
export const USDC_DEVNET_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')

export function giftAddress(creator, giftHash) {
  return PublicKey.findProgramAddressSync([
    Buffer.from('gift'), new PublicKey(creator).toBuffer(), Buffer.from(giftHash),
  ], SOLGIFT_PROGRAM_ID)[0]
}

export function decodeGiftAccount(accountInfo) {
  if (!accountInfo || !accountInfo.owner.equals(SOLGIFT_PROGRAM_ID)) throw new Error('On-chain gift account not found')
  const data = Buffer.from(accountInfo.data)
  if (data.length < 180 || !data.subarray(0, 8).equals(GIFT_ACCOUNT_DISCRIMINATOR)) {
    throw new Error('Invalid Solgift gift account data')
  }
  const asset = data[72]
  const status = data[129]
  const recipientOption = data[130]
  const reservedStart = recipientOption === 1 ? 165 : 132
  return {
    giftHash: data.subarray(8, 40),
    creator: new PublicKey(data.subarray(40, 72)),
    asset: asset === 0 ? 'SOL' : asset === 1 ? 'USDC' : null,
    mint: new PublicKey(data.subarray(73, 105)),
    amount: data.readBigUInt64LE(105),
    expiresAt: Number(data.readBigInt64LE(113)),
    status: status === 0 ? 'active' : status === 1 ? 'claimed' : status === 2 ? 'refunded' : 'unknown',
    recipient: recipientOption === 1 ? new PublicKey(data.subarray(131, 163)) : null,
    feeReserveLamports: data.readBigUInt64LE(reservedStart),
  }
}

export async function buildSponsoredClaimTransaction({
  connection, feeSponsor, creator, giftAddress: giftAddressValue, giftHash, giftSecret, currency, recipient,
  feeReimbursementLamports = 0n,
}) {
  const creatorKey = new PublicKey(creator)
  const gift = new PublicKey(giftAddressValue)
  const recipientKey = new PublicKey(recipient)
  const hashBytes = Buffer.from(giftHash)
  const secretBytes = Buffer.from(giftSecret)
  if (hashBytes.length !== 32 || secretBytes.length !== 32) throw new Error('Invalid gift claim secret')
  if (!giftAddress(creatorKey, hashBytes).equals(gift)) throw new Error('Gift PDA does not match its creator and hash')

  const transaction = new Transaction({ feePayer: feeSponsor.publicKey })
  const keys = [
    { pubkey: creatorKey, isSigner: false, isWritable: true },
    { pubkey: gift, isSigner: false, isWritable: true },
    { pubkey: recipientKey, isSigner: true, isWritable: true },
    { pubkey: feeSponsor.publicKey, isSigner: true, isWritable: true },
  ]
  let discriminator = CLAIM_SOL_DISCRIMINATOR

  if (currency === 'USDC') {
    const vault = await getAssociatedTokenAddress(USDC_DEVNET_MINT, gift, true)
    const recipientToken = await getAssociatedTokenAddress(USDC_DEVNET_MINT, recipientKey)
    transaction.add(createAssociatedTokenAccountIdempotentInstruction(
      feeSponsor.publicKey, recipientToken, recipientKey, USDC_DEVNET_MINT, TOKEN_PROGRAM_ID,
    ))
    discriminator = CLAIM_USDC_DISCRIMINATOR
    keys.push(
      { pubkey: USDC_DEVNET_MINT, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: recipientToken, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    )
  } else if (currency === 'SOL') {
    keys.push({ pubkey: SystemProgram.programId, isSigner: false, isWritable: false })
  } else {
    throw new Error('Unsupported gift currency')
  }

  transaction.add(new TransactionInstruction({
    programId: SOLGIFT_PROGRAM_ID,
    keys,
    data: Buffer.concat([discriminator, hashBytes, secretBytes, Buffer.from(amountBuffer(feeReimbursementLamports))]),
  }))
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  transaction.recentBlockhash = blockhash
  transaction.partialSign(feeSponsor)
  return { transaction, blockhash, lastValidBlockHeight }
}

function amountBuffer(value) {
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64LE(BigInt(value))
  return buffer
}
