import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { resolve, join } from 'node:path'

import { defineConfig } from 'vite'

// Copy directory recursively
function copyDir(src: string, dest: string) {
  mkdirSync(dest, { recursive: true })
  for (const file of readdirSync(src)) {
    const srcPath = join(src, file)
    const destPath = join(dest, file)
    if (statSync(srcPath).isDirectory()) {
      copyDir(srcPath, destPath)
    } else {
      copyFileSync(srcPath, destPath)
    }
  }
}

export default defineConfig(({ mode }) => {
  const outDir = mode === 'firefox' ? 'build/firefox' : 'build/chrome'

  return {
    base: './',
    build: {
      outDir,
      emptyDirBeforeWrite: true,
      rollupOptions: {
        input: {
          panel: resolve(__dirname, 'src/panel/index.html'),
          devtools: resolve(__dirname, 'src/panel/devtools.html'),
          'devtools-script': resolve(__dirname, 'src/panel/devtools.ts'),
          background: resolve(__dirname, 'src/background/index.ts'),
          content: resolve(__dirname, 'src/content/index.ts'),
        },
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: '[name].js',
          assetFileNames: 'assets/[name].[ext]',
        },
      },
    },
    plugins: [
      {
        name: 'extension-build',
        closeBundle() {
          const outPath = resolve(__dirname, outDir)
          const srcPanelPath = resolve(outPath, 'src/panel')

          // Move HTML files from src/panel/ to root and fix paths
          if (existsSync(srcPanelPath)) {
            const files = readdirSync(srcPanelPath)
            for (const file of files) {
              if (file.endsWith('.html')) {
                const srcFile = join(srcPanelPath, file)
                // Rename index.html to panel.html
                const destName = file === 'index.html' ? 'panel.html' : file
                const destFile = join(outPath, destName)

                // Read HTML and fix relative paths
                let content = readFileSync(srcFile, 'utf-8')
                // Fix paths like ../../panel.js to ./panel.js
                content = content.replace(/(?:\.\.\/)+/g, './')
                writeFileSync(destFile, content)
              }
            }
            // Remove the empty src directory
            rmSync(resolve(outPath, 'src'), { recursive: true, force: true })
          }

          // Copy manifest.json
          copyFileSync(resolve(__dirname, 'manifest.json'), resolve(outPath, 'manifest.json'))

          // Copy icons
          const iconsDir = resolve(__dirname, 'public/icons')
          const outIconsDir = resolve(outPath, 'icons')
          try {
            copyDir(iconsDir, outIconsDir)
          } catch {
            console.warn('Warning: Could not copy icons directory')
          }

          console.log('Extension built to', outDir)
        },
      },
    ],
  }
})
