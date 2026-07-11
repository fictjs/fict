import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'http://localhost/' })
for (const key of [
  'window',
  'document',
  'Node',
  'Element',
  'HTMLElement',
  'SVGElement',
  'MutationObserver',
  'CustomEvent',
  'Event',
  'MouseEvent',
  'FocusEvent',
  'FormData',
]) {
  globalThis[key] = dom.window[key]
}
globalThis.scrollTo = () => {}

const [
  { Link, MemoryRouter, Route, useNavigate },
  { render },
  { createSignal },
  { __fictProp },
  { jsx },
] = await Promise.all([
  import('../dist/index.js'),
  import('../../runtime/dist/index.js'),
  import('../../runtime/dist/advanced.js'),
  import('../../runtime/dist/internal.js'),
  import('../../runtime/dist/jsx-runtime.js'),
])

const to = createSignal('/first')
const disabled = createSignal(false)
const useSecondHandler = createSignal(false)
let firstCalls = 0
let secondCalls = 0
const link = jsx(Link, {
  to: __fictProp(() => to()),
  disabled: __fictProp(() => disabled()),
  onClick: __fictProp(() => (useSecondHandler() ? () => secondCalls++ : () => firstCalls++)),
  'data-testid': 'link',
  children: 'link',
})
const app = jsx(MemoryRouter, {
  initialEntries: ['/'],
  children: jsx(Route, { path: '/', element: link }),
})

const dispose = render(() => app, document.querySelector('#app'))
assert.equal(document.querySelector('[data-testid=link]').tagName, 'A')
assert.equal(document.querySelector('[data-testid=link]').getAttribute('href'), '/first')

to('/second')
disabled(true)
useSecondHandler(true)
await Promise.resolve()
await Promise.resolve()
assert.equal(document.querySelector('[data-testid=link]').tagName, 'SPAN')

disabled(false)
await Promise.resolve()
await Promise.resolve()
const current = document.querySelector('[data-testid=link]')
assert.equal(current.tagName, 'A')
assert.equal(current.getAttribute('href'), '/second')
current.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
assert.equal(firstCalls, 0)
assert.equal(secondCalls, 1)

dispose()

let aboutPreloads = 0
function HomeRoute() {
  const navigate = useNavigate()
  return jsx('button', {
    'data-testid': 'home-route',
    onClick: () => navigate('/about'),
    children: 'home',
  })
}

const routeApp = jsx(MemoryRouter, {
  initialEntries: ['/'],
  children: [
    jsx(Route, { path: '/', element: jsx(HomeRoute, {}) }),
    jsx(Route, {
      path: '/about',
      preload: () => {
        aboutPreloads++
        return 'ready'
      },
      element: jsx('main', { 'data-testid': 'about-route', children: 'about' }),
    }),
  ],
})

const disposeRoutes = render(() => routeApp, document.querySelector('#app'))
document
  .querySelector('[data-testid=home-route]')
  .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
await Promise.resolve()
await Promise.resolve()
await Promise.resolve()
assert.equal(document.querySelector('[data-testid=home-route]'), null)
assert.equal(document.querySelector('[data-testid=about-route]').textContent, 'about')
assert.equal(aboutPreloads, 1)

disposeRoutes()
dom.window.close()
