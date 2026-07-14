export function assertCliArguments(
  arguments_,
  { command, valueArguments = [], flagArguments = [] },
) {
  const values = new Set(valueArguments)
  const flags = new Set(flagArguments)
  const seen = new Set()

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (!argument.startsWith('--')) {
      throw new Error(`Unexpected ${command} positional argument: ${argument}`)
    }

    const separator = argument.indexOf('=')
    const name = argument.slice(2, separator === -1 ? undefined : separator)
    if (!name || (!values.has(name) && !flags.has(name))) {
      throw new Error(`Unknown ${command} argument: --${name}`)
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate ${command} argument: --${name}`)
    }
    seen.add(name)

    if (flags.has(name)) {
      if (separator !== -1) {
        throw new Error(`${command} flag --${name} does not accept a value`)
      }
      continue
    }

    if (separator !== -1) {
      if (!argument.slice(separator + 1)) {
        throw new Error(`${command} argument --${name} requires a value`)
      }
      continue
    }

    const value = arguments_[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${command} argument --${name} requires a value`)
    }
    index += 1
  }
}
