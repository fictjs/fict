const fs = require('fs')
const path = require('path')

const packages = fs.readdirSync(path.resolve(__dirname, '../packages'))

const scopes = [...packages, 'docs', 'examples', 'deps', 'release', 'others']

module.exports = {
  scopes,
}
