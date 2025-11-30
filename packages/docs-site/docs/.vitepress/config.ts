import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Fict',
  description: 'Reactive UI with zero boilerplate',

  head: [['link', { rel: 'icon', href: '/favicon.ico' }]],

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: 'Guide', link: '/guide/' },
      { text: 'API', link: '/api/' },
      { text: 'Examples', link: '/examples/' },
      {
        text: 'Links',
        items: [
          { text: 'GitHub', link: 'https://github.com/fictjs/fict' },
          { text: 'Changelog', link: 'https://github.com/fictjs/fict/blob/main/CHANGELOG.md' },
        ],
      },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'What is Fict?', link: '/guide/' },
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'Fiction UI Philosophy', link: '/guide/fiction-ui' },
          ],
        },
        {
          text: 'Core Concepts',
          items: [
            { text: '$state', link: '/guide/state' },
            { text: 'Derived Values', link: '/guide/derived' },
            { text: '$effect', link: '/guide/effect' },
            { text: 'Components', link: '/guide/components' },
          ],
        },
        {
          text: 'Advanced',
          items: [
            { text: 'Async Effects', link: '/guide/async' },
            { text: 'Deep Reactivity', link: '/guide/deep-reactivity' },
            { text: 'Performance', link: '/guide/performance' },
          ],
        },
      ],
      '/api/': [
        {
          text: 'Core',
          items: [
            { text: '$state', link: '/api/state' },
            { text: '$effect', link: '/api/effect' },
            { text: 'onMount', link: '/api/on-mount' },
            { text: 'onDestroy', link: '/api/on-destroy' },
          ],
        },
        {
          text: 'Advanced (fict/plus)',
          items: [
            { text: '$store', link: '/api/store' },
            { text: 'resource', link: '/api/resource' },
            { text: 'transition', link: '/api/transition' },
          ],
        },
      ],
    },

    socialLinks: [{ icon: 'github', link: 'https://github.com/fictjs/fict' }],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2024-present',
    },

    search: {
      provider: 'local',
    },
  },
})
