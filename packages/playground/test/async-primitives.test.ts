import { describe, expect, it } from 'vitest'

import { AsyncLimiter, withTimeout } from '../src/server/async-primitives'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

describe('async primitives', () => {
  it('executes tasks without exceeding max concurrency', async () => {
    const limiter = new AsyncLimiter(2)
    let active = 0
    let maxActive = 0

    const runTask = async (delayMs: number): Promise<void> => {
      await limiter.run(async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await sleep(delayMs)
        active -= 1
      })
    }

    await Promise.all([runTask(40), runTask(40), runTask(40), runTask(40)])
    expect(maxActive).toBeLessThanOrEqual(2)
  })

  it('supports holding a limiter slot beyond a timed-out caller', async () => {
    const limiter = new AsyncLimiter(1)
    const release = await limiter.acquire()

    let secondStarted = false
    const longTask = sleep(80).finally(() => {
      release()
    })

    await expect(
      withTimeout(10, 'timeout', async () => {
        await longTask
      }),
    ).rejects.toThrow('timeout')

    const second = limiter.run(async () => {
      secondStarted = true
    })

    await sleep(15)
    expect(secondStarted).toBe(false)

    await longTask
    await second
    expect(secondStarted).toBe(true)
  })
})
