/** Display only: decimal strings never pass through floating-point billing math. */
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/
const INTEGER = /^(?:0|[1-9]\d*)$/

export function isMoneyString(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL.test(value)
}
export function isTokenString(value: unknown): value is string {
  return typeof value === 'string' && INTEGER.test(value)
}

function grouped(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Round half-up for display, with string carry even beyond Number.MAX_VALUE. */
function rounded(integer: string, fraction: string, places: number): string {
  const kept = fraction.padEnd(places, '0').slice(0, places)
  let digits = integer + kept
  if ((fraction[places] ?? '0') >= '5') {
    const chars = digits.split('')
    let carry = true
    for (let i = chars.length - 1; i >= 0 && carry; i -= 1) {
      const digit = chars[i] ?? '0'
      if (digit === '9') chars[i] = '0'
      else { chars[i] = String(Number(digit) + 1); carry = false }
    }
    digits = (carry ? '1' : '') + chars.join('')
  }
  if (places === 0) return grouped(digits)
  const whole = digits.slice(0, -places) || '0'
  return grouped(whole) + '.' + digits.slice(-places).padStart(places, '0')
}

/** Adaptive currency precision; an absent/invalid amount is not a zero. */
export function moneyString(value: string | null | undefined, currency: 'cny' | 'usd' = 'cny'): string {
  if (!isMoneyString(value)) return '—'
  const [integer = '0', fraction = ''] = value.split('.')
  const symbol = currency === 'cny' ? '¥' : '$'
  if (integer === '0' && !/[1-9]/.test(fraction)) return symbol + '0'
  const places = integer !== '0' ? 2 : (fraction.slice(0, 2).padEnd(2, '0') === '00' ? 4 : 3)
  let result = rounded(integer, fraction, places)
  // A carry that crosses into whole units is a whole-unit amount: keep its two places.
  if (integer === '0' && !result.startsWith('0')) result = rounded(integer, fraction, 2)
  // Trailing zeros past the second decimal carry no information.
  const [whole = '0', decimals] = result.split('.')
  if (decimals !== undefined && decimals.length > 2) result = whole + '.' + decimals.replace(/0+$/, '').padEnd(2, '0')
  if (!/[1-9]/.test(result)) return '<' + symbol + '0.' + '0'.repeat(places - 1) + '1'
  return symbol + result
}

/** Group exact counts below 10k, compact larger counts without Infinity. */
export function tokenString(value: string | null | undefined): string {
  if (!isTokenString(value)) return '—'
  if (value.length <= 4) return grouped(value)
  const scale = value.length >= 7 ? 6 : 3
  const suffix = scale === 6 ? 'M' : 'k'
  const integer = value.slice(0, -scale) || '0'
  const fraction = value.slice(-scale)
  const places = integer.length < 3 ? 1 : 0
  let result = rounded(integer, fraction, places).replace(/\.0$/, '')
  // A display-only carry at the k/M boundary is clearer as one million.
  if (suffix === 'k' && result === '1,000') { result = '1'; return result + 'M' }
  return result + suffix
}

export function countdownString(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  let seconds = Math.max(0, Math.ceil(ms / 1000))
  const days = Math.floor(seconds / 86400)
  seconds %= 86400
  const hours = Math.floor(seconds / 3600)
  seconds %= 3600
  const minutes = Math.floor(seconds / 60)
  const pad = (n: number): string => String(n).padStart(2, '0')
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${pad(minutes)}m`
  return `${minutes}m ${pad(seconds % 60)}s`
}
