import type { AnalyzeRequest, CompileRequest, NativeCompilerOptions } from './types'

export interface CompilerEnvironmentPolicyInput {
  nodeEnv?: string | undefined
  strictGuaranteeEnv?: string | undefined
}

function readBooleanValue(raw: string | undefined): boolean | undefined {
  if (!raw) return undefined
  const normalized = raw.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false
  }
  return undefined
}

function processEnvironment(): CompilerEnvironmentPolicyInput {
  return {
    nodeEnv: process.env.NODE_ENV,
    strictGuaranteeEnv: process.env.FICT_STRICT_GUARANTEE,
  }
}

/**
 * Resolve the fail-closed production policy shared by every official compiler entrypoint.
 *
 * An explicit `false` is honored only outside production and when the environment does not force
 * strict guarantees. Missing and explicit `true` values remain strict by default.
 */
export function resolveStrictGuarantee(
  requested: boolean | undefined,
  environment: CompilerEnvironmentPolicyInput = processEnvironment(),
): boolean {
  return (
    readBooleanValue(environment.strictGuaranteeEnv) === true ||
    environment.nodeEnv === 'production' ||
    requested !== false
  )
}

export function applyCompilerEnvironmentPolicy(
  options: NativeCompilerOptions | undefined,
  environment?: CompilerEnvironmentPolicyInput,
): NativeCompilerOptions {
  const strictGuarantee = resolveStrictGuarantee(options?.strictGuarantee, environment)
  if (options?.strictGuarantee === strictGuarantee) return options
  return { ...options, strictGuarantee }
}

export function applyCompileRequestEnvironmentPolicy(
  request: CompileRequest,
  environment?: CompilerEnvironmentPolicyInput,
): CompileRequest {
  const options = applyCompilerEnvironmentPolicy(request.options, environment)
  if (options === request.options) return request
  return { ...request, options }
}

export function applyAnalyzeRequestEnvironmentPolicy(
  request: AnalyzeRequest,
  environment?: CompilerEnvironmentPolicyInput,
): AnalyzeRequest {
  const compilerOptions = applyCompilerEnvironmentPolicy(
    request.options?.compilerOptions,
    environment,
  )
  if (compilerOptions === request.options?.compilerOptions) return request
  return { ...request, options: { ...request.options, compilerOptions } }
}
