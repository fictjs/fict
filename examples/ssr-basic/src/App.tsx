import { $effect, $state } from 'fict'

type Risk = 'standard' | 'elevated' | 'critical'
type DeploymentState = 'Ready' | 'Progressing' | 'Paused'

const deployments: Array<{
  id: string
  service: string
  region: string
  owner: string
  state: DeploymentState
}> = [
  { id: 'DEP-842', service: 'Identity', region: 'US East', owner: 'Platform', state: 'Ready' },
  {
    id: 'DEP-839',
    service: 'Messaging',
    region: 'EU West',
    owner: 'Realtime',
    state: 'Progressing',
  },
  { id: 'DEP-835', service: 'Billing', region: 'US West', owner: 'Commerce', state: 'Paused' },
  { id: 'DEP-831', service: 'Analytics', region: 'AP South', owner: 'Data', state: 'Ready' },
]

function CapacityControl(props: { id: string; label: string; initial: number }) {
  let capacity = $state(props.initial)

  $effect(() => {
    console.log(`[${props.label}] target capacity changed: ${capacity}`)
  })

  return (
    <section class="capacity-card">
      <span>{props.label}</span>
      <strong data-testid={`capacity-${props.id}-value`}>{capacity}%</strong>
      <div class="capacity-actions">
        <button
          class="button secondary"
          data-testid={`capacity-${props.id}-decrement`}
          onClick$={() => (capacity = Math.max(0, capacity - 5))}
        >
          -5
        </button>
        <button
          class="button primary"
          data-testid={`capacity-${props.id}-increment`}
          onClick={() => (capacity = Math.min(100, capacity + 5))}
        >
          +5
        </button>
        <button class="button secondary" onClick={() => (capacity = props.initial)}>
          Reset
        </button>
      </div>
    </section>
  )
}

function ChangeRequest() {
  let title = $state<string>('Promote messaging canary')
  let risk = $state<Risk>('elevated')
  let approved = $state(false)

  const submit = (event: Event) => {
    event.preventDefault()
    approved = title.trim().length > 4
  }

  return (
    <form class="panel change-form" onSubmit={submit}>
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Resumable form</p>
          <h2>Change request</h2>
        </div>
        <span class={approved ? 'status ready' : 'status'}>{approved ? 'Queued' : 'Draft'}</span>
      </div>
      <label>
        Summary
        <input
          data-testid="change-title"
          value={title}
          onInput={(event: Event) => (title = (event.target as HTMLInputElement).value)}
        />
      </label>
      <label>
        Risk lane
        <select
          data-testid="change-risk"
          value={risk}
          onChange={(event: Event) => (risk = (event.target as HTMLSelectElement).value as Risk)}
        >
          <option value="standard">Standard</option>
          <option value="elevated">Elevated</option>
          <option value="critical">Critical</option>
        </select>
      </label>
      <button class="button primary" data-testid="change-submit" type="submit">
        Queue {risk} change
      </button>
      {approved && (
        <p class="success-note" data-testid="change-result">
          “{title}” entered the {risk} approval lane.
        </p>
      )}
    </form>
  )
}

function DeploymentQueue() {
  let filter = $state<'All' | DeploymentState>('All')

  return (
    <section class="panel deployment-panel">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Control flow</p>
          <h2>Deployment queue</h2>
        </div>
        <div class="filters">
          <button
            class={filter === 'All' ? 'filter active' : 'filter'}
            data-filter="All"
            onClick$={() => (filter = 'All')}
          >
            All
          </button>
          <button
            class={filter === 'Ready' ? 'filter active' : 'filter'}
            data-filter="Ready"
            onClick$={() => (filter = 'Ready')}
          >
            Ready
          </button>
          <button
            class={filter === 'Progressing' ? 'filter active' : 'filter'}
            data-filter="Progressing"
            onClick$={() => (filter = 'Progressing')}
          >
            Progressing
          </button>
          <button
            class={filter === 'Paused' ? 'filter active' : 'filter'}
            data-filter="Paused"
            onClick$={() => (filter = 'Paused')}
          >
            Paused
          </button>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Deployment</th>
            <th>Service</th>
            <th>Region</th>
            <th>Owner</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody data-testid="deployment-rows">
          {deployments.map(item =>
            filter === 'All' || item.state === filter ? (
              <tr key={item.id}>
                <td>{item.id}</td>
                <td>{item.service}</td>
                <td>{item.region}</td>
                <td>{item.owner}</td>
                <td>
                  <span class={`state ${item.state.toLowerCase()}`}>{item.state}</span>
                </td>
              </tr>
            ) : null,
          )}
        </tbody>
      </table>
    </section>
  )
}

export function App() {
  return (
    <main class="release-console">
      <header class="masthead">
        <div>
          <p class="eyebrow">Server-rendered application</p>
          <h1>Release operations console</h1>
          <p>Capacity, approvals, and deployment state for the current release window.</p>
        </div>
        <span class="live-indicator">SSR online</span>
      </header>

      <section class="capacity-grid" aria-label="Regional capacity">
        <CapacityControl id="east" label="US East" initial={65} />
        <CapacityControl id="west" label="EU West" initial={55} />
        <CapacityControl id="south" label="AP South" initial={45} />
      </section>

      <section class="workspace-grid">
        <ChangeRequest />
        <DeploymentQueue />
      </section>

      <aside class="preview-note">
        This fixture exercises server rendering and the Preview resumable loader under a production
        build. Core SSR support does not imply a stable resumability contract.
      </aside>
    </main>
  )
}
