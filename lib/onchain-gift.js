import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'

export const SOLGIFT_PROGRAM_ID = new PublicKey('A5cFtpUVnBncPqaBpUjHUtb9brk3qoPZSUjRdD3DTht2')
export const GIFT_ACCOUNT_DISCRIMINATOR = createHash('sha256').update('account:Gift').digest().subarray(0, 8)
export const CREATE_SOL_DISCRIMINATOR = createHash('sha256').update('global:create_sol_gift').digest().subarray(0, 8)
export const CREATE_USDC_DISCRIMINATOR = createHash('sha256').update('global:create_usdc_gift').digest().subarray(0, 8)
export const CREATE_SPL_DISCRIMINATOR = createHash('sha256').update('global:create_spl_gift').digest().subarray(0, 8)

export function giftAddress(creator, giftHash) {
  return PublicKey.findProgramAddressSync([
    Buffer.from('gift'), new PublicKey(creator).toBuffer(), Buffer.from(giftHash),
  ], SOLGIFT_PROGRAM_ID)[0]
}

export function decodeGiftAccount(accountInfo) {
  if (!accountInfo || !accountInfo.owner.equals(SOLGIFT_PROGRAM_ID)) throw new Error('On-chain gift account not found')
  const data = Buffer.from(accountInfo.data)
  if (data.length < 164 || !data.subarray(0, 8).equals(GIFT_ACCOUNT_DISCRIMINATOR)) {
    throw new Error('Invalid Solgift gift account data')
  }
  const asset = data[72]
  const status = data[129]
  const recipientOption = data[130]
  return {
    giftHash: data.subarray(8, 40),
    creator: new PublicKey(data.subarray(40, 72)),
    asset: asset === 0 ? 'SOL' : asset === 1 ? 'USDC' : asset === 2 ? 'SPL' : null,
    mint: new PublicKey(data.subarray(73, 105)),
    amount: data.readBigUInt64LE(105),
    expiresAt: Number(data.readBigInt64LE(113)),
    status: status === 0 ? 'active' : status === 1 ? 'claimed' : status === 2 ? 'refunded' : 'unknown',
    recipient: recipientOption === 1 ? new PublicKey(data.subarray(131, 163)) : null,
  }
}
