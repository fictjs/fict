export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'style',
        'refactor',
        'perf',
        'test',
        'build',
        'ci',
        'chore',
        'revert',
      ],
    ],
    'scope-enum': [
      2,
      'always',
      [
        'runtime',
        'compiler',
        'compiler-ts',
        'compiler-swc',
        'vite-plugin',
        'eslint-plugin',
        'devtools',
        'docs',
        'examples',
        'deps',
        'release',
      ],
    ],
  },
}
