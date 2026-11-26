/**
 * Secret redaction, applied to transcript text before any model call and
 * again to every note the dream proposes.
 *
 * @module @natgurlain/dsh-dreaming/pipeline/redact
 */

const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private key]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[jwt]'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, '[api key]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g, '[github token]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, '[slack token]'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[aws key]'],
  [/\bAIza[A-Za-z0-9_-]{35}\b/g, '[google key]'],
  [/\b(bearer|authorization:)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [token]'],
  [/\b((?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1[redacted]'],
  [/\b(?:\d[ -]?){13,19}\b/g, '[number]'],
]

export function redact(text: string): string {
  let result = text
  for (const [pattern, replacement] of PATTERNS) result = result.replace(pattern, replacement)
  return result
}
