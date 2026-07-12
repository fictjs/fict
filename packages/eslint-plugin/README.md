# @fictjs/eslint-plugin

![Node CI](https://github.com/fictjs/fict/workflows/CI/badge.svg)
![npm](https://img.shields.io/npm/v/fict.svg)
![license](https://img.shields.io/npm/l/fict)

ESLint plugin for Fict

## Usage

```bash
npm install -D @fictjs/eslint-plugin
# or
yarn add -D @fictjs/eslint-plugin
```

You can visit [Fict](https://github.com/fictjs/fict) for more documentation.

## Flat config (ESLint 9+)

```js
// eslint.config.js
import fict from '@fictjs/eslint-plugin'

export default [fict.configs.recommended]
```

The recommended config registers the plugin itself, enables JSX parsing, and
turns on the supported Fict rules. To customize it, spread the config and
override individual rules:

```js
import fict from '@fictjs/eslint-plugin'

export default [
  {
    ...fict.configs.recommended,
    rules: {
      ...fict.configs.recommended.rules,
      'fict/no-inline-functions': 'off',
    },
  },
]
```
