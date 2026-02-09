declare module 'vite' {
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
}
