import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddress,
} from '@solana/spl-token'
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js'

export const SOLGIFT_PROGRAM_ID = new PublicKey('A5cFtpUVnBncPqaBpUjHUtb9brk3qoPZSUjRdD3DTht2')
export const USDC_DEVNET_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')

const CREATE_SOL = Buffer.from([16, 218, 222, 28, 15, 37, 11, 18])
const CREATE_USDC = Buffer.from([29, 42, 92, 142, 183, 189, 95, 31])
const CLAIM_SOL = Buffer.from([144, 133, 16, 213, 214, 223, 141, 83])
const CLAIM_USDC = Buffer.from([169, 189, 169, 109, 229, 119, 70, 210])
const CREATE_SPL = Buffer.from([112, 130, 144, 62, 31, 18, 136, 163])
const CLAIM_SPL = Buffer.from([108, 231, 225, 44, 145, 38, 243, 100])

export function decodeBase64Url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
}

export function encodeBase64Url(value) {
  return btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function giftPda(creator, giftHash) {
  return PublicKey.findProgramAddressSync([
    Buffer.from('gift'), new PublicKey(creator).toBuffer(), Buffer.from(giftHash),
  ], SOLGIFT_PROGRAM_ID)[0]
}

function amountBuffer(value) {
  const result = Buffer.alloc(8)
  result.writeBigUInt64LE(BigInt(value))
  return result
}

function timestampBuffer(value) {
  const result = Buffer.alloc(8)
  result.writeBigInt64LE(BigInt(value))
  return result
}

export async function createGiftInstruction({ creator, giftAddress, giftHash, currency, tokenMint, amount, expiresAt }) {
  const creatorKey = new PublicKey(creator)
  const hashBytes = Buffer.from(giftHash)
  const gift = giftPda(creatorKey, hashBytes)
  if (!gift.equals(new PublicKey(giftAddress))) throw new Error('Эскроу-адрес не совпадает с адресом программы')

  if (currency === 'SOL') {
    return new TransactionInstruction({
      programId: SOLGIFT_PROGRAM_ID,
      keys: [
        { pubkey: creatorKey, isSigner: true, isWritable: true },
        { pubkey: gift, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([CREATE_SOL, hashBytes, amountBuffer(amount), timestampBuffer(expiresAt)]),
    })
  }

  const mint = currency === 'USDC' ? USDC_DEVNET_MINT : new PublicKey(tokenMint)
  const creatorToken = await getAssociatedTokenAddress(mint, creatorKey)
  const vault = await getAssociatedTokenAddress(mint, gift, true)
  const discriminator = currency === 'USDC' ? CREATE_USDC : CREATE_SPL
  return new TransactionInstruction({
    programId: SOLGIFT_PROGRAM_ID,
    keys: [
      { pubkey: creatorKey, isSigner: true, isWritable: true },
      { pubkey: gift, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: creatorToken, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([discriminator, hashBytes, amountBuffer(amount), timestampBuffer(expiresAt)]),
  })
}

export async function claimGiftInstruction({ creator, giftAddress, giftHash, giftSecret, currency, tokenMint, recipient }) {
  const creatorKey = new PublicKey(creator)
  const recipientKey = new PublicKey(recipient)
  const gift = new PublicKey(giftAddress)
  const hashBytes = Buffer.from(giftHash)
  const secretBytes = Buffer.from(giftSecret)
  if (hashBytes.length !== 32 || secretBytes.length !== 32) throw new Error('Некорректный секрет ваучера')
  if (!giftPda(creatorKey, hashBytes).equals(gift)) throw new Error('Адрес ваучера не совпадает с адресом программы')

  const keys = [
    { pubkey: creatorKey, isSigner: false, isWritable: false },
    { pubkey: gift, isSigner: false, isWritable: true },
    { pubkey: recipientKey, isSigner: true, isWritable: true },
  ]
  let discriminator = CLAIM_SOL
  if (currency === 'USDC' || currency === 'SPL') {
    const mint = currency === 'USDC' ? USDC_DEVNET_MINT : new PublicKey(tokenMint)
    const vault = await getAssociatedTokenAddress(mint, gift, true)
    const recipientToken = await getAssociatedTokenAddress(mint, recipientKey)
    discriminator = currency === 'USDC' ? CLAIM_USDC : CLAIM_SPL
    keys.push(
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: recipientToken, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    )
  }
  return new TransactionInstruction({
    programId: SOLGIFT_PROGRAM_ID,
    keys,
    data: Buffer.concat([discriminator, hashBytes, secretBytes]),
  })
}
