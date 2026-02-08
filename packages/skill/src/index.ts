export interface FictSkillPackageInfo {
  name: string
  version: string
}

export function getSkillPackageInfo(): FictSkillPackageInfo {
  return {
    name: '@fictjs/skill',
    version: '0.8.0',
  }
}
