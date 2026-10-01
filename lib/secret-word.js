import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

const SCRYPT_OPTIONS = { N: 1 << 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const SCRYPT_BYTES = 32

function scryptAsync(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_BYTES, SCRYPT_OPTIONS, (error, derivedKey) => {
      if (error) reject(error)
      else resolve(derivedKey)
    })
  })
}

export function normalizeSecretWord(value) {
  if (typeof value !== 'string') throw new Error('Secret word is required')
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
  const length = [...normalized].length
  if (length < 12 || Buffer.byteLength(normalized, 'utf8') > 256) {
    throw new Error('Secret phrase must be 12–256 characters; use several words')
  }
  return normalized
}

function pepperedSecret(value, pepper) {
  return createHmac('sha256', pepper).update('solgift:secret-word:v1\0').update(value).digest()
}

export async function createSecretWordVerifier(value, pepper) {
  const normalized = normalizeSecretWord(value)
  const salt = randomBytes(16)
  const verifier = await scryptAsync(pepperedSecret(normalized, pepper), salt)
  return { salt: salt.toString('hex'), verifier: verifier.toString('hex') }
}

export async function verifySecretWord(value, saltHex, verifierHex, pepper) {
  let normalized
  try { normalized = normalizeSecretWord(value) } catch { return false }
  if (!/^[0-9a-f]{32}$/i.test(saltHex || '') || !/^[0-9a-f]{64}$/i.test(verifierHex || '')) return false
  const expected = Buffer.from(verifierHex, 'hex')
  const actual = await scryptAsync(pepperedSecret(normalized, pepper), Buffer.from(saltHex, 'hex'))
  return timingSafeEqual(actual, expected)
}
