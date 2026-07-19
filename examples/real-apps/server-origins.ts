const DEFAULT_PORTS = {
  operations: 23173,
  resumableSsr: 23174,
  streamingSsr: 23175,
} as const

function readPort(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback

  const port = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || String(port) !== raw) {
    throw new Error(
      `${name} must be an integer between 1 and 65535; received ${JSON.stringify(raw)}`,
    )
  }
  return port
}

export const realAppPorts = {
  operations: readPort('FICT_REAL_APP_OPERATIONS_PORT', DEFAULT_PORTS.operations),
  resumableSsr: readPort('FICT_REAL_APP_RESUMABLE_SSR_PORT', DEFAULT_PORTS.resumableSsr),
  streamingSsr: readPort('FICT_REAL_APP_STREAMING_SSR_PORT', DEFAULT_PORTS.streamingSsr),
} as const

export const realAppOrigins = {
  operations: `http://127.0.0.1:${realAppPorts.operations}`,
  resumableSsr: `http://127.0.0.1:${realAppPorts.resumableSsr}`,
  streamingSsr: `http://127.0.0.1:${realAppPorts.streamingSsr}`,
} as const
