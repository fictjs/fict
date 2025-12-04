export interface RuntimeFeatureFlags {
  fineGrainedRendering: boolean
}

const flags: RuntimeFeatureFlags = {
  fineGrainedRendering: false,
}

export function enableFineGrainedRuntime(): void {
  flags.fineGrainedRendering = true
}

export function disableFineGrainedRuntime(): void {
  flags.fineGrainedRendering = false
}

export function setRuntimeFeatureFlags(next: Partial<RuntimeFeatureFlags>): void {
  if (typeof next.fineGrainedRendering === 'boolean') {
    flags.fineGrainedRendering = next.fineGrainedRendering
  }
}

export function getRuntimeFeatureFlags(): Readonly<RuntimeFeatureFlags> {
  return flags
}

export function isFineGrainedRuntimeEnabled(): boolean {
  return flags.fineGrainedRendering
}
