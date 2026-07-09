/**
 * Validate names before passing them to DOM implementations.
 *
 * Browsers validate ordinary element/attribute names using the XML `Name`
 * production. Namespace-aware APIs additionally require a `QName`. Some
 * server-side DOM implementations are more permissive and can serialize an
 * invalid name as markup, so Fict performs the browser validation itself.
 */

function isNameStartCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x3a ||
    (codePoint >= 0x41 && codePoint <= 0x5a) ||
    codePoint === 0x5f ||
    (codePoint >= 0x61 && codePoint <= 0x7a) ||
    (codePoint >= 0xc0 && codePoint <= 0xd6) ||
    (codePoint >= 0xd8 && codePoint <= 0xf6) ||
    (codePoint >= 0xf8 && codePoint <= 0x2ff) ||
    (codePoint >= 0x370 && codePoint <= 0x37d) ||
    (codePoint >= 0x37f && codePoint <= 0x1fff) ||
    (codePoint >= 0x200c && codePoint <= 0x200d) ||
    (codePoint >= 0x2070 && codePoint <= 0x218f) ||
    (codePoint >= 0x2c00 && codePoint <= 0x2fef) ||
    (codePoint >= 0x3001 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfdcf) ||
    (codePoint >= 0xfdf0 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0xeffff)
  )
}

function isNameCodePoint(codePoint: number): boolean {
  return (
    isNameStartCodePoint(codePoint) ||
    codePoint === 0x2d ||
    codePoint === 0x2e ||
    (codePoint >= 0x30 && codePoint <= 0x39) ||
    codePoint === 0xb7 ||
    (codePoint >= 0x300 && codePoint <= 0x36f) ||
    (codePoint >= 0x203f && codePoint <= 0x2040)
  )
}

function isValidDOMName(name: string): boolean {
  if (name.length === 0) return false

  let index = 0
  for (const character of name) {
    const codePoint = character.codePointAt(0)
    if (codePoint === undefined) return false
    if (index === 0 ? !isNameStartCodePoint(codePoint) : !isNameCodePoint(codePoint)) {
      return false
    }
    index++
  }
  return true
}

function isValidDOMQualifiedName(name: string): boolean {
  const firstColon = name.indexOf(':')
  if (firstColon === -1) return isValidDOMName(name)
  if (firstColon === 0 || name.indexOf(':', firstColon + 1) !== -1) return false
  return isValidDOMName(name.slice(0, firstColon)) && isValidDOMName(name.slice(firstColon + 1))
}

function invalidCharacterError(kind: 'element' | 'attribute', name: string): Error {
  const message = `[fict] Invalid ${kind} name ${JSON.stringify(name)}.`
  if (typeof DOMException === 'function') {
    return new DOMException(message, 'InvalidCharacterError')
  }

  const error = new Error(message)
  error.name = 'InvalidCharacterError'
  return error
}

export function assertValidDOMElementName(name: string, namespaceAware = false): void {
  const valid = namespaceAware ? isValidDOMQualifiedName(name) : isValidDOMName(name)
  if (!valid) throw invalidCharacterError('element', name)
}

export function assertValidDOMAttributeName(name: string, namespaceAware = false): void {
  const valid = namespaceAware ? isValidDOMQualifiedName(name) : isValidDOMName(name)
  if (!valid) throw invalidCharacterError('attribute', name)
}
