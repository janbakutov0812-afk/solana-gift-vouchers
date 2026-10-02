import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddress,
} from '@solana/spl-token'
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js'
import { SOLGIFT_PROGRAM_ABI } from '../shared/solgift-program-config.js'

export const SOLGIFT_PROGRAM_ID = new PublicKey('A5cFtpUVnBncPqaBpUjHUtb9brk3qoPZSUjRdD3DTht2')
export const USDC_DEVNET_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')

const CREATE_SOL = Buffer.from([16, 218, 222, 28, 15, 37, 11, 18])
const CREATE_USDC = Buffer.from([29, 42, 92, 142, 183, 189, 95, 31])
const CLAIM_SOL = Buffer.from([144, 133, 16, 213, 214, 223, 141, 83])
const CLAIM_USDC = Buffer.from([169, 189, 169, 109, 229, 119, 70, 210])

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

export async function createGiftInstruction({ creator, giftAddress, giftHash, currency, amount, feeReserveLamports, expiresAt, programAbiVersion = SOLGIFT_PROGRAM_ABI }) {
  if (programAbiVersion !== SOLGIFT_PROGRAM_ABI) throw new Error('The site and escrow API use different program versions.')
  const creatorKey = new PublicKey(creator)
  const hashBytes = Buffer.from(giftHash)
  const createArgs = [CREATE_SOL, hashBytes, amountBuffer(amount)]
  if (programAbiVersion === 'fee-reserve') createArgs.push(amountBuffer(feeReserveLamports))
  createArgs.push(timestampBuffer(expiresAt))
  const gift = giftPda(creatorKey, hashBytes)
  if (!gift.equals(new PublicKey(giftAddress))) throw new Error('The escrow address does not match the program address.')

  if (currency === 'SOL') {
    return new TransactionInstruction({
      programId: SOLGIFT_PROGRAM_ID,
      keys: [
        { pubkey: creatorKey, isSigner: true, isWritable: true },
        { pubkey: gift, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat(createArgs),
    })
  }

  const creatorToken = await getAssociatedTokenAddress(USDC_DEVNET_MINT, creatorKey)
  const vault = await getAssociatedTokenAddress(USDC_DEVNET_MINT, gift, true)
  return new TransactionInstruction({
    programId: SOLGIFT_PROGRAM_ID,
    keys: [
      { pubkey: creatorKey, isSigner: true, isWritable: true },
      { pubkey: gift, isSigner: false, isWritable: true },
      { pubkey: USDC_DEVNET_MINT, isSigner: false, isWritable: false },
      { pubkey: creatorToken, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([CREATE_USDC, ...createArgs.slice(1)]),
  })
}

export async function claimGiftInstruction({ creator, giftAddress, giftHash, giftSecret, currency, recipient, feeSponsor, feeReimbursementLamports = 0n }) {
  const creatorKey = new PublicKey(creator)
  const recipientKey = new PublicKey(recipient)
  const feeSponsorKey = feeSponsor ? new PublicKey(feeSponsor) : null
  const gift = new PublicKey(giftAddress)
  const hashBytes = Buffer.from(giftHash)
  const secretBytes = Buffer.from(giftSecret)
  if (hashBytes.length !== 32 || secretBytes.length !== 32) throw new Error('Invalid gift secret.')
  if (!giftPda(creatorKey, hashBytes).equals(gift)) throw new Error('The gift address does not match the program address.')

  const keys = [
    { pubkey: creatorKey, isSigner: false, isWritable: true },
    { pubkey: gift, isSigner: false, isWritable: true },
    { pubkey: recipientKey, isSigner: true, isWritable: true },
  ]
  if (SOLGIFT_PROGRAM_ABI === 'fee-reserve') {
    if (!feeSponsorKey) throw new Error('A fee sponsor is required by the deployed escrow program.')
    keys.push({ pubkey: feeSponsorKey, isSigner: true, isWritable: true })
  }
  let discriminator = CLAIM_SOL
  if (currency === 'USDC') {
    const vault = await getAssociatedTokenAddress(USDC_DEVNET_MINT, gift, true)
    const recipientToken = await getAssociatedTokenAddress(USDC_DEVNET_MINT, recipientKey)
    discriminator = CLAIM_USDC
    keys.push(
      { pubkey: USDC_DEVNET_MINT, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: recipientToken, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    )
  } else {
    keys.push({ pubkey: SystemProgram.programId, isSigner: false, isWritable: false })
  }
  return new TransactionInstruction({
    programId: SOLGIFT_PROGRAM_ID,
    keys,
    data: Buffer.concat([
      discriminator, hashBytes, secretBytes,
      ...(SOLGIFT_PROGRAM_ABI === 'fee-reserve' ? [amountBuffer(feeReimbursementLamports)] : []),
    ]),
  })
}
