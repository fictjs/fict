export function generatedCode(kind, size) {
  const terms = fn => Array.from({ length: size }, (_, index) => fn(index))
  const prelude = "import { $state } from 'fict';"
  const sources = {
    branches: () =>
      `export function f(x){${terms(i => `${i ? 'else ' : ''}if(x===${i})return ${i};`).join('')}return -1;}`,
    switch: () =>
      `export function f(x){switch(x){${terms(i => `case ${i}:return ${i};`).join('')}default:return -1;}}`,
    sum: () =>
      `${prelude}export function App(){let c=$state(0);const x=${terms(() => 'c').join('+')};return <button onClick={()=>c++}>{x}</button>}`,
    handler: () =>
      `${prelude}export function App(){let c=$state(0);return <button onClick={e=>{${terms(i => `${i ? 'else ' : ''}if(e.detail===${i})c=${i};`).join('')}}}>{c}</button>}`,
    icons: () =>
      terms(
        i =>
          `export function Icon${i}(props){return <svg width={props.size??24} height={props.size??24} viewBox="0 0 24 24"><path d="M0 0L24 24Z"/></svg>}`,
      ).join('\n'),
    components: () =>
      `${prelude}${terms(i => `export function App${i}(){let c=$state(0);return <button onClick={()=>c++}>{c}</button>}`).join('\n')}`,
    states: () =>
      `${prelude}export function App(){${terms(i => `let c${i}=$state(0);`).join('')}return <button onClick={()=>{${terms(i => `c${i}++;`).join('')}}}>{${terms(i => `c${i}`).join('+')}}</button>}`,
    derived: () =>
      `${prelude}export function App(){let c=$state(0);${terms(i => `const d${i}=${i ? `d${i - 1}` : 'c'}+1;`).join('')}return <button onClick={()=>c++}>{d${size - 1}}</button>}`,
    jsx: () => `export function App(){return ${'<div>'.repeat(size)}1${'</div>'.repeat(size)}}`,
    parens: () => `export const v=${'('.repeat(size)}1${')'.repeat(size)};`,
    object: () => `export const tree=${'{c:'.repeat(size)}1${'}'.repeat(size)};`,
  }
  if (!sources[kind]) throw new Error(`Unknown generated-code fixture: ${kind}`)
  return sources[kind]()
}

export const generatedCodeSizes = {
  branches: [100, 200, 400, 1000],
  switch: [100, 200, 400],
  sum: [100, 200, 400],
  handler: [100, 200, 400],
  icons: [250, 500, 1000, 2000],
  components: [250, 500],
  states: [250, 500],
  derived: [250, 500],
}
