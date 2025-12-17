// Quick test to understand the compilation
const fs = require('fs')
const path = require('path')

// Since transformCommonJS is in dist, let's check what's there
const distPath = path.join(__dirname, 'dist')
if (fs.existsSync(distPath)) {
  console.log('dist/ exists, checking contents:')
  const files = fs.readdirSync(distPath)
  console.log(files.slice(0, 10))
} else {
  console.log('dist/ does not exist - need to build first')
}

// Also check if we can find the compiled test
const testUtilsPath = path.join(__dirname, 'dist/test/test-utils.js')
console.log('\ntest-utils.js exists:', fs.existsSync(testUtilsPath))
