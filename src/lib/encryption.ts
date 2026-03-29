import crypto from 'crypto'

const ALGO = 'aes-256-gcm'

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY
  if (raw && raw.length === 64) return Buffer.from(raw, 'hex')
  // Fallback: derive a 256-bit key from AUTH_SECRET so no new env var is required
  const secret = process.env.AUTH_SECRET ?? 'zman-dev-secret-please-change-me'
  if (process.env.NODE_ENV === 'production' && !process.env.ENCRYPTION_KEY) {
    console.warn('[ENCRYPTION] ENCRYPTION_KEY not set — deriving from AUTH_SECRET. Set ENCRYPTION_KEY (64 hex chars) for stronger isolation.')
  }
  return crypto.createHash('sha256').update(secret).digest()
}

export function encryptApiKey(plaintext: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return JSON.stringify({
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: enc.toString('hex'),
  })
}

export function decryptApiKey(encrypted: string): string {
  const { iv, tag, data } = JSON.parse(encrypted) as { iv: string; tag: string; data: string }
  const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(iv, 'hex'))
  decipher.setAuthTag(Buffer.from(tag, 'hex'))
  return decipher.update(Buffer.from(data, 'hex')).toString('utf8') + decipher.final('utf8')
}

export function maskApiKey(key: string): string {
  if (key.length <= 8) return '****'
  return key.slice(0, 3) + '****' + key.slice(-4)
}
