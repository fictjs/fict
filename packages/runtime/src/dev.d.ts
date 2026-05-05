export {}

declare global {
  const __DEV__: boolean | undefined
  const process:
    | {
        env?: {
          NODE_ENV?: string
          [key: string]: string | undefined
        }
      }
    | undefined
}
