import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, SystemProgram } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token'
import {
  buildSponsoredClaimTransaction, CLAIM_SOL_DISCRIMINATOR, CLAIM_USDC_DISCRIMINATOR,
  giftAddress, SOLGIFT_PROGRAM_ID,
} from './onchain-gift.js'

const fakeConnection = {
  async getLatestBlockhash() {
    return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 123 }
  },
}

for (const currency of ['SOL', 'USDC']) {
  test(`${currency} claim is sponsored by the relayer and still requires recipient signature`, async () => {
    const sponsor = Keypair.generate()
    const creator = Keypair.generate().publicKey
    const recipient = Keypair.generate().publicKey
    const giftHash = Buffer.alloc(32, currency === 'SOL' ? 3 : 4)
    const secret = Buffer.alloc(32, 8)
    const gift = giftAddress(creator, giftHash)
    const result = await buildSponsoredClaimTransaction({
      connection: fakeConnection, feeSponsor: sponsor, creator, giftAddress: gift,
      giftHash, giftSecret: secret, currency, recipient, feeReimbursementLamports: 14_000n,
    })

    assert.equal(result.transaction.feePayer.toBase58(), sponsor.publicKey.toBase58())
    const signers = result.transaction.compileMessage().accountKeys
      .filter((_, index) => result.transaction.compileMessage().isAccountSigner(index))
      .map((key) => key.toBase58())
    assert.deepEqual(signers, [sponsor.publicKey.toBase58(), recipient.toBase58()])
    assert.ok(result.transaction.signatures[0].signature)
    assert.equal(result.transaction.signatures[1].signature, null)
    assert.doesNotThrow(() => result.transaction.serialize({ requireAllSignatures: false, verifySignatures: true }))

    if (currency === 'SOL') {
      assert.equal(result.transaction.instructions.length, 1)
      assert.ok(result.transaction.instructions[0].programId.equals(SOLGIFT_PROGRAM_ID))
      assert.ok(result.transaction.instructions[0].data.subarray(0, 8).equals(CLAIM_SOL_DISCRIMINATOR))
      assert.equal(result.transaction.instructions[0].data.readBigUInt64LE(72), 14_000n)
      assert.ok(result.transaction.instructions[0].keys.at(-1).pubkey.equals(SystemProgram.programId))
      assert.equal(result.transaction.instructions[0].keys[0].isWritable, true)
    } else {
      assert.equal(result.transaction.instructions.length, 2)
      assert.ok(result.transaction.instructions[0].programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID))
      assert.ok(result.transaction.instructions[1].programId.equals(SOLGIFT_PROGRAM_ID))
      assert.ok(result.transaction.instructions[1].data.subarray(0, 8).equals(CLAIM_USDC_DISCRIMINATOR))
      assert.equal(result.transaction.instructions[1].data.readBigUInt64LE(72), 14_000n)
      assert.equal(result.transaction.instructions[1].keys[0].isWritable, true)
    }
  })
}

test('gift account decoder reads the reserve before and after claim serialization', async () => {
  const { decodeGiftAccount, GIFT_ACCOUNT_DISCRIMINATOR } = await import('./onchain-gift.js')
  const account = Buffer.alloc(181)
  GIFT_ACCOUNT_DISCRIMINATOR.copy(account)
  account[72] = 0
  account[129] = 0
  account[130] = 0
  account.writeBigUInt64LE(120_000n, 132)
  assert.equal(decodeGiftAccount({ owner: SOLGIFT_PROGRAM_ID, data: account }).feeReserveLamports, 120_000n)
  account[130] = 1
  account.writeBigUInt64LE(120_000n, 165)
  assert.equal(decodeGiftAccount({ owner: SOLGIFT_PROGRAM_ID, data: account }).feeReserveLamports, 120_000n)
})
