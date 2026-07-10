/**
 * Validate names before passing them to DOM implementations.
 *
 * Browsers validate ordinary element/attribute names using the XML `Name`
 * production. Namespace-aware APIs additionally require a `QName`. Some
 * server-side DOM implementations are more permissive and can serialize an
 * invalid name as markup, so Fict performs the browser validation itself.
 */

const XML_NAME_START =
  ':A-Z_a-z\\u00c0-\\u00d6\\u00d8-\\u00f6\\u00f8-\\u02ff\\u0370-\\u037d\\u037f-\\u1fff\\u200c-\\u200d\\u2070-\\u218f\\u2c00-\\u2fef\\u3001-\\ud7ff\\uf900-\\ufdcf\\ufdf0-\\ufffd\\u{10000}-\\u{effff}'
const XML_NAME = RegExp(
  // eslint-disable-next-line no-misleading-character-class -- XML NameChar includes combining marks by definition.
  `^[${XML_NAME_START}][-.${XML_NAME_START}\\d\\u00b7\\u0300-\\u036f\\u203f-\\u2040]*$`,
  'u',
)
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace'
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/'

function isValidDOMName(name: string): boolean {
  return XML_NAME.test(name)
}

function isValidDOMQualifiedName(name: string): boolean {
  const firstColon = name.indexOf(':')
  return (
    isValidDOMName(name) &&
    (firstColon === -1 ||
      (firstColon > 0 &&
        name.indexOf(':', firstColon + 1) === -1 &&
        isValidDOMName(name.slice(firstColon + 1))))
  )
}

function assertValidDOMName(
  kind: 'element' | 'attribute',
  name: string,
  namespaceAware: boolean,
  namespaceURI?: string | null,
): void {
  const valid = namespaceAware ? isValidDOMQualifiedName(name) : isValidDOMName(name)
  if (!valid) {
    throwDOMNameError(kind, name, 'InvalidCharacterError')
  }

  if (namespaceURI === undefined) return

  const colonIndex = name.indexOf(':')
  const prefix = colonIndex === -1 ? null : name.slice(0, colonIndex)
  const hasInvalidNamespace =
    (prefix !== null && namespaceURI === null) ||
    (prefix === 'xml' && namespaceURI !== XML_NAMESPACE) ||
    ((name === 'xmlns' || prefix === 'xmlns') && namespaceURI !== XMLNS_NAMESPACE) ||
    (namespaceURI === XMLNS_NAMESPACE && name !== 'xmlns' && prefix !== 'xmlns')

  if (hasInvalidNamespace) {
    throwDOMNameError(kind, name, 'NamespaceError')
  }
}

function throwDOMNameError(
  kind: 'element' | 'attribute',
  name: string,
  errorName: 'InvalidCharacterError' | 'NamespaceError',
): never {
  const qualifier = errorName === 'NamespaceError' ? 'namespace for ' : ''
  const message = `[fict] Invalid ${qualifier}${kind} name ${JSON.stringify(name)}.`
  if (typeof DOMException === 'function') {
    throw new DOMException(message, errorName)
  }

  const error = new Error(message)
  error.name = errorName
  throw error
}

export function assertValidDOMElementName(
  name: string,
  namespaceAware = false,
  namespaceURI?: string | null,
): void {
  assertValidDOMName('element', name, namespaceAware, namespaceURI)
}

export function assertValidDOMAttributeName(
  name: string,
  namespaceAware = false,
  namespaceURI?: string | null,
): void {
  assertValidDOMName('attribute', name, namespaceAware, namespaceURI)
}
