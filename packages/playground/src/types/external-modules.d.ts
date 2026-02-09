declare module 'vite' {
  export interface PlaygroundLikeLogger {
    warn: (message: string, options?: unknown) => void
    error: (message: string, options?: unknown) => void
    [key: string]: unknown
  }

  export interface PlaygroundLikeViteServer {
    listen: () => Promise<void>
    close: () => Promise<void>
    resolvedUrls?: {
      local?: string[]
      network?: string[]
    }
    httpServer?: {
      address: () => { port: number } | string | null
    }
  }

  export function createServer(options: unknown): Promise<PlaygroundLikeViteServer>
  export function build(options: unknown): Promise<unknown>
  export function createLogger(
    level?: string,
    options?: { allowClearScreen?: boolean },
  ): PlaygroundLikeLogger
}
