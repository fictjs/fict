import { $state, render, createSelector, batch, untrack } from 'fict'
import { createSignal, type Signal } from 'fict/advanced'

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
      label: createSignal(
        `${adjectives[random(adjectives.length)]} ${colours[random(colours.length)]} ${nouns[random(nouns.length)]}`,
      ),
    }
  }
  return data
}

function removeById(rows: { id: number; label: Signal<string> }[], id: number) {
  const index = rows.findIndex(row => row.id === id)
  if (index < 0) return rows
  const next = rows.slice()
  next.splice(index, 1)
  return next
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
  let data: { id: number; label: Signal<string> }[] = $state([])
  let selected: number | null = $state(null)
  const isSelected = createSelector(() => selected)

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
    batch(() => {
      for (let i = 0, rows = data; i < rows.length; i += 10) {
        const label = rows[i]!.label
        label(label() + ' !!!')
      }
    })
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
    const next = removeById(data, id)
    if (next !== data) data = next
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
          {data.map(item => {
            const row = untrack(() => item)
            return (
              <tr key={item.id} class={isSelected(row.id) ? 'danger' : ''}>
                <td class="col-md-1" textContent={row.id} />
                <td class="col-md-4">
                  <a onClick={() => select(row.id)} textContent={row.label()} />
                </td>
                <td class="col-md-1">
                  <a onClick={() => remove(row.id)}>
                    <span class="glyphicon glyphicon-remove" aria-hidden="true"></span>
                  </a>
                </td>
                <td class="col-md-6"></td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <span class="preloadicon glyphicon glyphicon-remove" aria-hidden="true"></span>
    </div>
  )
}

const app = document.getElementById('main')
if (app) {
  render(() => <App />, app)
}

export default App
