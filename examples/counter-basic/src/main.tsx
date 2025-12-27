import { $state, render } from 'fict'

const adjectives = [
  'pretty',
  'large',
  'big',
  'small',
  'tall',
  'short',
  'long',
  'handsome',
  'plain',
  'quaint',
  'clean',
  'elegant',
  'easy',
  'angry',
  'crazy',
  'helpful',
  'mushy',
  'odd',
  'unsightly',
  'adorable',
  'important',
  'inexpensive',
  'cheap',
  'expensive',
  'fancy',
]

const colours = [
  'red',
  'yellow',
  'blue',
  'green',
  'pink',
  'brown',
  'purple',
  'brown',
  'white',
  'black',
  'orange',
]

const nouns = [
  'table',
  'chair',
  'house',
  'bbq',
  'desk',
  'car',
  'pony',
  'cookie',
  'sandwich',
  'burger',
  'pizza',
  'mouse',
  'keyboard',
]

let nextId = 1
function random(max: number) {
  return Math.round(Math.random() * 1000) % max
}

function buildData(count: number) {
  const data = new Array(count)
  for (let i = 0; i < count; i++) {
    data[i] = {
      id: nextId++,
      label: `${adjectives[random(adjectives.length)]} ${colours[random(colours.length)]} ${nouns[random(nouns.length)]}`,
    }
  }
  return data
}

function Button(props: any) {
  return (
    <div class="col-sm-6 smallpad">
      <button id={props.id} class="btn btn-primary btn-block" type="button" onClick={props.onClick}>
        {props.text}
      </button>
    </div>
  )
}

function App() {
  let data: { id: number; label: string }[] = $state([])
  let selected: number | null = $state(null)

  const run = () => {
    data = buildData(1000)
    selected = null
  }

  const runLots = () => {
    data = buildData(10000)
    selected = null
  }

  const add = () => {
    data = [...data, ...buildData(1000)]
  }

  const update = () => {
    data = data.map((row, i) => (i % 10 === 0 ? { ...row, label: row.label + ' !!!' } : row))
  }

  const swapRows = () => {
    const list = data
    if (list.length <= 998) return
    const copy = list.slice()
    const tmp = copy[1]
    copy[1] = copy[998]
    copy[998] = tmp
    data = copy
  }

  const clear = () => {
    data = []
    selected = null
  }

  const remove = (id: number) => {
    data = data.filter(row => row.id !== id)
    if (selected === id) {
      selected = null
    }
  }

  const select = (id: number) => {
    selected = id
  }

  return (
    <div class="container">
      <div class="jumbotron">
        <div class="row">
          <div class="col-md-6">
            <h1>Fict Keyed</h1>
          </div>
          <div class="col-md-6">
            <div class="row">
              <Button id="run" text="Create 1,000 rows" onClick={run} />
              <Button id="runlots" text="Create 10,000 rows" onClick={runLots} />
              <Button id="add" text="Append 1,000 rows" onClick={add} />
              <Button id="update" text="Update every 10th row" onClick={update} />
              <Button id="clear" text="Clear" onClick={clear} />
              <Button id="swaprows" text="Swap Rows" onClick={swapRows} />
            </div>
          </div>
        </div>
      </div>
      <table class="table table-hover table-striped test-data">
        <tbody>
          {data.map(row => (
            <tr key={row.id} class={selected === row.id ? 'danger' : ''}>
              <td class="col-md-1">{row.id}</td>
              <td class="col-md-4">
                <a onClick={() => select(row.id)}>{row.label}</a>
              </td>
              <td class="col-md-1">
                <a onClick={() => remove(row.id)}>
                  <span class="glyphicon glyphicon-remove" aria-hidden="true"></span>
                </a>
              </td>
              <td class="col-md-6"></td>
            </tr>
          ))}
        </tbody>
      </table>
      <span class="preloadicon glyphicon glyphicon-remove" aria-hidden="true"></span>
    </div>
  )
}

const app = document.getElementById('app')
if (app) {
  render(() => <App />, app)
}

export default App
