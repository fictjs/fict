import { promises as fs } from 'node:fs'
import path from 'node:path'

export type DoctorStatus = 'pass' | 'warn' | 'info'

export interface DoctorCheck {
  id: string
  title: string
  status: DoctorStatus
  detail: string
  fix?: string
}

interface PackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function formatStatus(status: DoctorStatus): string {
  if (status === 'pass') return 'PASS'
  if (status === 'warn') return 'WARN'
  return 'INFO'
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch {
    return null
  }
}

async function findViteConfig(rootPath: string): Promise<string | null> {
  const names = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs']

  for (const name of names) {
    const candidate = path.join(rootPath, name)
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      continue
    }
  }

  return null
}

function hasDependency(pkg: PackageJson | null, name: string): boolean {
  if (!pkg) return false
  return !!pkg.dependencies?.[name] || !!pkg.devDependencies?.[name]
}

export async function runProjectDoctor(rootPath: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = []
  const packageJsonPath = path.join(rootPath, 'package.json')
  const tsconfigPath = path.join(rootPath, 'tsconfig.json')

  const pkg = await readJsonFile<PackageJson>(packageJsonPath)
  const tsconfig = await readJsonFile<{ compilerOptions?: { jsxImportSource?: string } }>(
    tsconfigPath,
  )
  const viteConfigPath = await findViteConfig(rootPath)
  const viteConfigText = viteConfigPath ? await readTextFile(viteConfigPath) : null

  if (tsconfig?.compilerOptions?.jsxImportSource === 'fict') {
    checks.push({
      id: 'tsconfig-jsx-import-source',
      title: 'TypeScript JSX import source',
      status: 'pass',
      detail: 'tsconfig.json sets compilerOptions.jsxImportSource to "fict".',
    })
  } else {
    checks.push({
      id: 'tsconfig-jsx-import-source',
      title: 'TypeScript JSX import source',
      status: 'warn',
      detail: 'tsconfig.json does not set compilerOptions.jsxImportSource to "fict".',
      fix: 'Add compilerOptions.jsxImportSource = "fict" in tsconfig.json.',
    })
  }

  if (
    viteConfigText &&
    (/[@/]fictjs\/vite-plugin/.test(viteConfigText) || /\bfict\s*\(/.test(viteConfigText))
  ) {
    checks.push({
      id: 'vite-plugin',
      title: 'Vite plugin integration',
      status: 'pass',
      detail: 'Detected @fictjs/vite-plugin usage in Vite config.',
    })
  } else {
    checks.push({
      id: 'vite-plugin',
      title: 'Vite plugin integration',
      status: 'warn',
      detail: 'Could not verify @fictjs/vite-plugin integration in Vite config.',
      fix: 'Install and register @fictjs/vite-plugin in vite.config.ts.',
    })
  }

  if (hasDependency(pkg, '@fictjs/eslint-plugin')) {
    checks.push({
      id: 'eslint-plugin',
      title: 'ESLint plugin integration',
      status: 'pass',
      detail: 'Detected @fictjs/eslint-plugin in package dependencies.',
    })
  } else {
    checks.push({
      id: 'eslint-plugin',
      title: 'ESLint plugin integration',
      status: 'warn',
      detail: 'Missing @fictjs/eslint-plugin in package dependencies.',
      fix: 'Install @fictjs/eslint-plugin and extend plugin:fict/recommended.',
    })
  }

  if (hasDependency(pkg, '@fictjs/devtools')) {
    checks.push({
      id: 'devtools',
      title: 'Devtools package',
      status: 'pass',
      detail: 'Detected @fictjs/devtools in package dependencies.',
    })
  } else {
    checks.push({
      id: 'devtools',
      title: 'Devtools package',
      status: 'info',
      detail: 'Optional: @fictjs/devtools is not installed.',
      fix: 'Install @fictjs/devtools for live trace and browser inspection workflows.',
    })
  }

  return checks
}

export function formatDoctorReport(checks: DoctorCheck[]): string {
  return checks
    .map(check => {
      const fix = check.fix ? `\n  fix: ${check.fix}` : ''
      return `[${formatStatus(check.status)}] ${check.title}\n  ${check.detail}${fix}`
    })
    .join('\n\n')
}
