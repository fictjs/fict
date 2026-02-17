import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import manifest from '../skills/manifest.json'

export interface FictSkillPackageInfo {
  name: string
  version: string
}

export interface FictSkillMetadata {
  version: string
  organization: string
  date: string
  abstract: string
  references?: string[]
}

export interface FictSkillManifestEntry {
  name: string
  title: string
  description: string
  version: string
  path: string
  skill: string
  agents: string
  metadata: string
  rulesDir: string
}

export interface FictSkillSummary {
  name: string
  title: string
  description: string
  version: string
}

export type FictSkillDocumentType = 'skill' | 'agents' | 'metadata'

interface SkillManifestFile {
  skills: FictSkillManifestEntry[]
}

interface StackFrameLike {
  getFileName?: () => string | null
}

const skillManifest = manifest as SkillManifestFile
const skillMap = new Map(skillManifest.skills.map(skill => [skill.name, skill]))

let cachedPackageRoot: string | null = null
let cachedPackageInfo: FictSkillPackageInfo | null = null

function isValidPackageRoot(candidate: string): boolean {
  return (
    existsSync(path.join(candidate, 'package.json')) && existsSync(path.join(candidate, 'skills'))
  )
}

function detectModuleDirFromStack(): string | null {
  const originalPrepare = Error.prepareStackTrace

  try {
    Error.prepareStackTrace = (_, stack) => stack
    const stack = new Error().stack as unknown

    if (!Array.isArray(stack)) {
      return null
    }

    for (const frame of stack as StackFrameLike[]) {
      if (!frame || typeof frame.getFileName !== 'function') {
        continue
      }

      const rawFile = frame.getFileName()
      if (!rawFile || rawFile === '[eval]' || rawFile.startsWith('node:')) {
        continue
      }

      const filePath = rawFile.startsWith('file://') ? fileURLToPath(rawFile) : rawFile
      if (!path.isAbsolute(filePath)) {
        continue
      }

      return path.dirname(filePath)
    }
  } catch {
    return null
  } finally {
    Error.prepareStackTrace = originalPrepare
  }

  return null
}

function resolvePackageRoot(): string {
  if (cachedPackageRoot) {
    return cachedPackageRoot
  }

  const candidates = new Set<string>()

  if (typeof __dirname === 'string') {
    candidates.add(path.resolve(__dirname, '..'))
  }

  const stackModuleDir = detectModuleDirFromStack()
  if (stackModuleDir) {
    candidates.add(path.resolve(stackModuleDir, '..'))
  }

  candidates.add(path.join(process.cwd(), 'node_modules', '@fictjs', 'skill'))

  const checked = Array.from(candidates)

  for (const candidate of checked) {
    if (isValidPackageRoot(candidate)) {
      cachedPackageRoot = candidate
      return candidate
    }
  }

  throw new Error(`Unable to locate @fictjs/skill package root. Checked: ${checked.join(', ')}`)
}

function resolveSkillsRoot(): string {
  return path.join(resolvePackageRoot(), 'skills')
}

function ensureSkillEntry(skillName: string): FictSkillManifestEntry {
  const entry = skillMap.get(skillName)
  if (!entry) {
    throw new Error(
      `Unknown skill "${skillName}". Available skills: ${Array.from(skillMap.keys()).join(', ')}`,
    )
  }
  return entry
}

function resolveSkillFilePath(skillName: string, docType: FictSkillDocumentType): string {
  const skill = ensureSkillEntry(skillName)
  const relativePath = skill[docType]
  return path.join(resolveSkillsRoot(), relativePath)
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T
}

export function getSkillPackageInfo(): FictSkillPackageInfo {
  if (cachedPackageInfo) {
    return cachedPackageInfo
  }

  const packagePath = path.join(resolvePackageRoot(), 'package.json')
  const pkg = readJsonFile<{ name?: string; version?: string }>(packagePath)

  cachedPackageInfo = {
    name: pkg.name ?? '@fictjs/skill',
    version: pkg.version ?? '0.0.0',
  }

  return cachedPackageInfo
}

export function listSkills(): FictSkillSummary[] {
  return skillManifest.skills.map(skill => ({
    name: skill.name,
    title: skill.title,
    description: skill.description,
    version: skill.version,
  }))
}

export function getSkillManifestEntry(skillName: string): FictSkillManifestEntry {
  return ensureSkillEntry(skillName)
}

export function hasSkill(skillName: string): boolean {
  return skillMap.has(skillName)
}

export function getSkillPath(skillName: string): string {
  const skill = ensureSkillEntry(skillName)
  return path.join(resolveSkillsRoot(), skill.path)
}

export function readSkillDocument(skillName: string, docType: FictSkillDocumentType): string {
  const filePath = resolveSkillFilePath(skillName, docType)
  return readFileSync(filePath, 'utf8')
}

export function readSkillMetadata(skillName: string): FictSkillMetadata {
  return JSON.parse(readSkillDocument(skillName, 'metadata')) as FictSkillMetadata
}

export function getSkillDocuments(skillName: string): {
  skill: string
  agents: string
  metadata: FictSkillMetadata
} {
  return {
    skill: readSkillDocument(skillName, 'skill'),
    agents: readSkillDocument(skillName, 'agents'),
    metadata: readSkillMetadata(skillName),
  }
}
