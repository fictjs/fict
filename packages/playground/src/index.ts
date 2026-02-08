export interface FictPlaygroundPackageInfo {
  name: string
  version: string
}

export function getPlaygroundPackageInfo(): FictPlaygroundPackageInfo {
  return {
    name: '@fictjs/playground',
    version: '0.8.0',
  }
}
