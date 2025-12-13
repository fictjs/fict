/// <reference types="@fictjs/compiler/dist/index.d.ts" />
/// <reference types="vite/client" />

declare const $state: <T>(initialValue: T) => T
declare const $effect: (fn: () => void | (() => void)) => void
declare const $memo: <T>(fn: () => T) => T
