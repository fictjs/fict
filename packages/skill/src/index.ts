import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

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

const runtimeRequire = createRequire(path.join(process.cwd(), '__fict_skill_resolver__.cjs'))
const skillManifest = manifest as SkillManifestFile
const skillMap = new Map(skillManifest.skills.map(skill => [skill.name, skill]))

let cachedPackageRoot: string | null = null
let cachedPackageInfo: FictSkillPackageInfo | null = null

function isValidPackageRoot(candidate: string): boolean {
  return (
    existsSync(path.join(candidate, 'package.json')) && existsSync(path.join(candidate, 'skills'))
  )
}

function resolvePackageRoot(): string {
  if (cachedPackageRoot) {
    return cachedPackageRoot
  }

  const cwd = process.cwd()
  const workspaceCandidates = [path.join(cwd, 'packages/skill'), cwd]

  for (const candidate of workspaceCandidates) {
    if (isValidPackageRoot(candidate)) {
      cachedPackageRoot = candidate
      return candidate
    }
  }

  try {
    const pkgPath = runtimeRequire.resolve('@fictjs/skill/package.json')
    const packageRoot = path.dirname(pkgPath)
    if (isValidPackageRoot(packageRoot)) {
      cachedPackageRoot = packageRoot
      return packageRoot
    }
  } catch {
    // Fall through to last-resort path.
  }

  const fallback = path.join(cwd, 'node_modules', '@fictjs', 'skill')
  cachedPackageRoot = fallback
  return fallback
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
