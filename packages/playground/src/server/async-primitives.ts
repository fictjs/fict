export class AsyncLimiter {
  private readonly maxConcurrency: number
  private active = 0
  private readonly waiters: (() => void)[] = []

  constructor(maxConcurrency: number) {
    this.maxConcurrency = Math.max(1, maxConcurrency)
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await task()
    } finally {
      this.release()
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active += 1
      return
    }

    await new Promise<void>(resolve => {
      this.waiters.push(() => {
        this.active += 1
        resolve()
      })
    })
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1)
    const next = this.waiters.shift()
    if (next) {
      next()
    }
  }
}

export async function withTimeout<T>(
  timeoutMs: number,
  message: string,
  operation: () => Promise<T>,
): Promise<T> {
  const safeTimeoutMs = Math.max(1, timeoutMs)

  let timeoutHandle: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(message))
        }, safeTimeoutMs)
      }),
    ])
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle)
    }
  }
}
