#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'

import {
  assembleNativePackage,
  nativeHostTarget,
  nativeTargetDefinition,
} from './native-compiler-packages.mjs'

const root = process.cwd()
const releaseDirectory = path.join(root, 'target', 'release')
const destination = path.resolve(
  process.env.FICT_COMPILER_NATIVE_PATH ?? path.join(releaseDirectory, 'fict_compiler_napi.node'),
)

const candidates =
  process.platform === 'darwin'
    ? ['libfict_compiler_napi.dylib']
    : process.platform === 'linux'
      ? ['libfict_compiler_napi.so']
      : process.platform === 'win32'
        ? ['fict_compiler_napi.dll']
        : []

const sourceName = candidates.find(candidate => existsSync(path.join(releaseDirectory, candidate)))
if (!sourceName) {
  throw new Error(
    `No host native compiler artifact found for ${process.platform}/${process.arch} in ${releaseDirectory}`,
  )
}

mkdirSync(path.dirname(destination), { recursive: true })
// Replace the inode instead of overwriting an already-loaded Mach-O image. macOS
// caches code-signing metadata by vnode and can otherwise reject the copied
// add-on after a rebuild because its mtime no longer matches the cached image.
rmSync(destination, { force: true })
copyFileSync(path.join(releaseDirectory, sourceName), destination)
const target = nativeHostTarget()
const definition = nativeTargetDefinition(target)
const workspacePackage = path.join(root, definition.packageDirectory)
assembleNativePackage({
  target,
  binaryPath: destination,
  outputDirectory: workspacePackage,
  root,
})
console.log(
  JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    source: sourceName,
    destination,
    workspacePackage,
  }),
)
