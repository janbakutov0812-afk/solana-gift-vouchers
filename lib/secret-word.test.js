import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createSecretWordVerifier, normalizeSecretWord, verifySecretWord } from './secret-word.js'

const pepper = Buffer.alloc(32, 0x5a)
const phrase = 'Синий чай и звёзды 2026'

describe('secret phrase verifier', () => {
  it('normalizes case, compatibility characters, and repeated whitespace', () => {
    assert.equal(normalizeSecretWord('  СИНИЙ　чай   и звёзды 2026  '), phrase.toLowerCase())
  })

  it('creates a salted verifier that accepts normalized input', async () => {
    const saved = await createSecretWordVerifier(phrase, pepper)

    assert.match(saved.salt, /^[0-9a-f]{32}$/)
    assert.match(saved.verifier, /^[0-9a-f]{64}$/)
    assert.equal(await verifySecretWord('  синий   чай и звёзды 2026 ', saved.salt, saved.verifier, pepper), true)
  })

  it('rejects a different phrase or a different server pepper', async () => {
    const saved = await createSecretWordVerifier(phrase, pepper)

    assert.equal(await verifySecretWord('Красный чай и звёзды 2026', saved.salt, saved.verifier, pepper), false)
    assert.equal(await verifySecretWord(phrase, saved.salt, saved.verifier, Buffer.alloc(32, 0x33)), false)
  })

  it('rejects short phrases and malformed stored verifiers', async () => {
    await assert.rejects(createSecretWordVerifier('too short', pepper), /12–256 characters/)
    assert.equal(await verifySecretWord(phrase, 'bad-salt', 'bad-verifier', pepper), false)
  })

  it('uses a fresh random salt for each voucher', async () => {
    const first = await createSecretWordVerifier(phrase, pepper)
    const second = await createSecretWordVerifier(phrase, pepper)

    assert.notEqual(first.salt, second.salt)
    assert.notEqual(first.verifier, second.verifier)
  })
})
