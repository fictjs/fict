export interface FictMcpPackageInfo {
  name: string
  version: string
}

export function getMcpPackageInfo(): FictMcpPackageInfo {
  return {
    name: '@fictjs/mcp',
    version: '0.8.0',
  }
}
