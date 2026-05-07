import { $state, $store, ErrorBoundary, render, type FictNode } from 'fict'
import { Link, NavLink, Route, Router } from '@fictjs/router'
import './styles.css'

type View = 'dashboard' | 'intake' | 'router' | 'auth'
type Range = 'today' | 'week' | 'month'
type Risk = 'low' | 'medium' | 'high'

const viewItems: Array<{ id: View; label: string; meta: string }> = [
  { id: 'dashboard', label: 'Operations', meta: 'Dashboard' },
  { id: 'intake', label: 'Procurement', meta: 'Form' },
  { id: 'router', label: 'Accounts', meta: 'Router' },
  { id: 'auth', label: 'Access', meta: 'Auth' },
]

const tickets = [
  { id: 'OPS-1248', owner: 'M. Chen', priority: 'High', status: 'Investigating', age: '18m' },
  { id: 'OPS-1242', owner: 'A. Rivera', priority: 'Medium', status: 'Waiting', age: '42m' },
  { id: 'OPS-1239', owner: 'N. Okafor', priority: 'Low', status: 'Scheduled', age: '2h' },
  { id: 'OPS-1236', owner: 'S. Patel', priority: 'High', status: 'Mitigated', age: '4h' },
]

const accounts = [
  { id: 'northwind', name: 'Northwind Supply', tier: 'Enterprise', renewal: 'Jun 12' },
  { id: 'atlas', name: 'Atlas Health', tier: 'Growth', renewal: 'Jul 03' },
  { id: 'vertex', name: 'Vertex Labs', tier: 'Enterprise', renewal: 'Aug 19' },
]

function App() {
  let activeView = $state<View>('dashboard')

  return (
    <div class="app-shell">
      <aside class="sidebar" aria-label="Application views">
        <div class="brand-block">
          <span class="brand-mark">F</span>
          <div>
            <strong>Fict Ops</strong>
            <span>Operations suite</span>
          </div>
        </div>

        <nav class="view-nav">
          {viewItems.map(item => (
            <button
              key={item.id}
              class={activeView === item.id ? 'view-nav-item is-active' : 'view-nav-item'}
              onClick={() => (activeView = item.id)}
            >
              <span>{item.meta}</span>
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      <section class="workspace">
        {activeView === 'dashboard' ? (
          <OperationsDashboard />
        ) : activeView === 'intake' ? (
          <ProcurementIntake />
        ) : activeView === 'router' ? (
          <NestedRouterWorkspace />
        ) : (
          <AccessConsole />
        )}
      </section>
    </div>
  )
}

function ProcurementIntake() {
  const request = $store({
    requester: 'Maya Chen',
    email: 'maya.chen@example.com',
    department: 'Revenue Operations',
    vendor: 'Northstar Analytics',
    category: 'Software',
    amount: 28500,
    risk: 'medium' as Risk,
    securityReview: true,
    legalReview: false,
    purchaseReason: 'Expand regional forecasting coverage for enterprise renewals.',
  })
  let submitted = $state(false)

  const amountNumber = Number(request.amount)
  const hasRequiredFields = Boolean(
    request.requester.trim() &&
    request.email.includes('@') &&
    request.vendor.trim() &&
    request.purchaseReason.trim(),
  )
  const approvalLane =
    request.risk === 'high' || amountNumber >= 50000
      ? 'Executive review'
      : request.securityReview || request.legalReview
        ? 'Specialist review'
        : 'Standard approval'

  const submit = (event: Event) => {
    event.preventDefault()
    submitted = true
  }

  return (
    <article class="surface">
      <header class="surface-header">
        <div>
          <p class="eyebrow">Procurement intake</p>
          <h1>Vendor request</h1>
        </div>
        <span class={hasRequiredFields ? 'status-pill ready' : 'status-pill'}>{approvalLane}</span>
      </header>

      <form class="intake-grid" onSubmit={submit}>
        <section class="panel form-panel">
          <h2>Requester</h2>
          <label>
            Name
            <input
              value={request.requester}
              onInput={(event: Event) =>
                (request.requester = (event.target as HTMLInputElement).value)
              }
            />
          </label>
          <label>
            Email
            <input
              type="email"
              value={request.email}
              onInput={(event: Event) => (request.email = (event.target as HTMLInputElement).value)}
            />
          </label>
          <label>
            Department
            <input
              value={request.department}
              onInput={(event: Event) =>
                (request.department = (event.target as HTMLInputElement).value)
              }
            />
          </label>
        </section>

        <section class="panel form-panel">
          <h2>Purchase</h2>
          <label>
            Vendor
            <input
              value={request.vendor}
              onInput={(event: Event) =>
                (request.vendor = (event.target as HTMLInputElement).value)
              }
            />
          </label>
          <label>
            Category
            <select
              value={request.category}
              onChange={(event: Event) =>
                (request.category = (event.target as HTMLSelectElement).value)
              }
            >
              <option>Software</option>
              <option>Services</option>
              <option>Infrastructure</option>
              <option>Data</option>
            </select>
          </label>
          <label>
            Budget
            <input
              type="number"
              value={request.amount}
              onInput={(event: Event) =>
                (request.amount = Number((event.target as HTMLInputElement).value))
              }
            />
          </label>
        </section>

        <section class="panel form-panel">
          <h2>Risk</h2>
          <div class="segmented">
            {(['low', 'medium', 'high'] as Risk[]).map(risk => (
              <button
                key={risk}
                type="button"
                class={request.risk === risk ? 'segment is-active' : 'segment'}
                onClick={() => (request.risk = risk)}
              >
                {risk}
              </button>
            ))}
          </div>
          <label class="check-row">
            <input
              type="checkbox"
              checked={request.securityReview}
              onChange={() => (request.securityReview = !request.securityReview)}
            />
            Security review
          </label>
          <label class="check-row">
            <input
              type="checkbox"
              checked={request.legalReview}
              onChange={() => (request.legalReview = !request.legalReview)}
            />
            Legal review
          </label>
          <label>
            Business reason
            <textarea
              value={request.purchaseReason}
              onInput={(event: Event) =>
                (request.purchaseReason = (event.target as HTMLTextAreaElement).value)
              }
            />
          </label>
        </section>

        <aside class="panel review-panel">
          <h2>Review</h2>
          <dl>
            <div>
              <dt>Vendor</dt>
              <dd>{request.vendor || 'Unassigned'}</dd>
            </div>
            <div>
              <dt>Budget</dt>
              <dd>${amountNumber.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Risk</dt>
              <dd>{request.risk}</dd>
            </div>
            <div>
              <dt>Lane</dt>
              <dd>{approvalLane}</dd>
            </div>
          </dl>
          <button class="primary-action" type="submit" disabled={!hasRequiredFields}>
            Submit request
          </button>
          {submitted && <p class="result-note">Request queued for {approvalLane.toLowerCase()}.</p>}
        </aside>
      </form>
    </article>
  )
}

function OperationsDashboard() {
  let range = $state<Range>('week')

  const metricSet =
    range === 'today'
      ? { revenue: '$84k', conversion: '4.8%', incidents: '7', health: '99.93%' }
      : range === 'week'
        ? { revenue: '$612k', conversion: '5.2%', incidents: '29', health: '99.97%' }
        : { revenue: '$2.8m', conversion: '5.6%', incidents: '118', health: '99.95%' }
  const pipeline =
    range === 'today'
      ? [
          { label: 'Qualified', value: 42 },
          { label: 'Contract', value: 28 },
          { label: 'Closed', value: 18 },
        ]
      : range === 'week'
        ? [
            { label: 'Qualified', value: 67 },
            { label: 'Contract', value: 46 },
            { label: 'Closed', value: 31 },
          ]
        : [
            { label: 'Qualified', value: 76 },
            { label: 'Contract', value: 58 },
            { label: 'Closed', value: 44 },
          ]

  return (
    <article class="surface">
      <header class="surface-header">
        <div>
          <p class="eyebrow">Operations dashboard</p>
          <h1>Commercial health</h1>
        </div>
        <div class="segmented compact">
          {(['today', 'week', 'month'] as Range[]).map(option => (
            <button
              key={option}
              class={range === option ? 'segment is-active' : 'segment'}
              onClick={() => (range = option)}
            >
              {option}
            </button>
          ))}
        </div>
      </header>

      <section class="metrics-grid">
        <Metric label="Revenue" value={metricSet.revenue} tone="green" />
        <Metric label="Conversion" value={metricSet.conversion} tone="blue" />
        <Metric label="Open incidents" value={metricSet.incidents} tone="red" />
        <Metric label="API health" value={metricSet.health} tone="purple" />
      </section>

      <section class="dashboard-grid">
        <div class="panel">
          <h2>Pipeline</h2>
          <div class="bar-list">
            {pipeline.map(stage => (
              <div class="bar-row" key={stage.label}>
                <span>{stage.label}</span>
                <div class="bar-track">
                  <i style={{ width: `${stage.value}%` }} />
                </div>
                <strong>{stage.value}%</strong>
              </div>
            ))}
          </div>
        </div>

        <div class="panel">
          <h2>Incident queue</h2>
          <table>
            <thead>
              <tr>
                <th>Ticket</th>
                <th>Owner</th>
                <th>Priority</th>
                <th>Age</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map(ticket => (
                <tr key={ticket.id}>
                  <td>{ticket.id}</td>
                  <td>{ticket.owner}</td>
                  <td>
                    <span class={`priority ${ticket.priority.toLowerCase()}`}>
                      {ticket.priority}
                    </span>
                  </td>
                  <td>{ticket.age}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </article>
  )
}

function Metric(props: { label: string; value: string; tone: string }) {
  return (
    <div class={`metric-card ${props.tone}`}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  )
}

function NestedRouterWorkspace() {
  return (
    <article class="surface">
      <header class="surface-header">
        <div>
          <p class="eyebrow">Nested router</p>
          <h1>Account workspace</h1>
        </div>
      </header>

      <div class="router-frame">
        <Router>
          <Route path="/" component={AccountLayout}>
            <Route index component={AccountOverview} />
            <Route path="accounts" component={AccountList} />
            <Route path="accounts/:id" component={AccountDetail} />
            <Route path="settings" component={AccountSettings} />
          </Route>
        </Router>
      </div>
    </article>
  )
}

function AccountLayout(props: { children?: FictNode }) {
  return (
    <div>
      <nav class="router-tabs">
        <NavLink to="/" end className="router-tab" activeClassName="is-active">
          Overview
        </NavLink>
        <NavLink to="/accounts" end className="router-tab" activeClassName="is-active">
          Accounts
        </NavLink>
        <NavLink to="/settings" className="router-tab" activeClassName="is-active">
          Settings
        </NavLink>
      </nav>
      <div class="router-outlet">{props.children}</div>
    </div>
  )
}

function AccountOverview() {
  return (
    <section class="route-panel">
      <h2>Portfolio overview</h2>
      <div class="account-grid">
        {accounts.map(account => (
          <Link key={account.id} to={`/accounts/${account.id}`} class="account-tile">
            <strong>{account.name}</strong>
            <span>{account.tier}</span>
            <small>Renewal {account.renewal}</small>
          </Link>
        ))}
      </div>
    </section>
  )
}

function AccountList() {
  return (
    <section class="route-panel">
      <h2>Managed accounts</h2>
      <table>
        <thead>
          <tr>
            <th>Account</th>
            <th>Tier</th>
            <th>Renewal</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map(account => (
            <tr key={account.id}>
              <td>
                <Link to={`/accounts/${account.id}`}>{account.name}</Link>
              </td>
              <td>{account.tier}</td>
              <td>{account.renewal}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function AccountDetail(props: { params: { id?: string } }) {
  const match = accounts.find(account => account.id === props.params.id) ?? accounts[0]
  return (
    <section class="route-panel split">
      <div>
        <p class="eyebrow">Account detail</p>
        <h2>{match.name}</h2>
        <p class="muted">Renewal motion, adoption risk, and executive sponsor coverage.</p>
      </div>
      <dl class="detail-list">
        <div>
          <dt>Tier</dt>
          <dd>{match.tier}</dd>
        </div>
        <div>
          <dt>Renewal</dt>
          <dd>{match.renewal}</dd>
        </div>
        <div>
          <dt>Owner</dt>
          <dd>Customer Operations</dd>
        </div>
      </dl>
    </section>
  )
}

function AccountSettings() {
  let notifications = $state(true)
  let autoArchive = $state(false)

  return (
    <section class="route-panel">
      <h2>Workspace settings</h2>
      <label class="toggle-row">
        <input
          type="checkbox"
          checked={notifications}
          onChange={() => (notifications = !notifications)}
        />
        Renewal alerts
      </label>
      <label class="toggle-row">
        <input
          type="checkbox"
          checked={autoArchive}
          onChange={() => (autoArchive = !autoArchive)}
        />
        Auto-archive closed plans
      </label>
    </section>
  )
}

function AccessConsole() {
  let email = $state('ops@example.com')
  let password = $state('')
  let status = $state<'signed-out' | 'loading' | 'signed-in'>('signed-out')
  let message = $state('')
  let auditBroken = $state(false)

  const submit = (event: Event) => {
    event.preventDefault()
    const submittedPassword = password
    message = ''
    if (submittedPassword === 'fict-v1') {
      status = 'loading'
    } else {
      status = 'signed-out'
      message = 'Access denied for this workspace.'
    }
  }

  const completeSignIn = () => {
    status = 'signed-in'
  }

  const signOut = () => {
    password = ''
    status = 'signed-out'
    message = ''
  }

  return (
    <article class="surface">
      <header class="surface-header">
        <div>
          <p class="eyebrow">Auth and recovery</p>
          <h1>Operator access</h1>
        </div>
        <span class={status === 'signed-in' ? 'status-pill ready' : 'status-pill'}>
          {status === 'signed-in' ? 'Signed in' : status === 'loading' ? 'Checking' : 'Signed out'}
        </span>
      </header>

      <section class="auth-grid">
        <form class="panel form-panel" onSubmit={submit}>
          <h2>Workspace sign-in</h2>
          <label>
            Email
            <input
              type="email"
              value={email}
              onInput={(event: Event) => (email = (event.target as HTMLInputElement).value)}
            />
          </label>
          <label>
            Access key
            <input
              type="password"
              value={password}
              onInput={(event: Event) => (password = (event.target as HTMLInputElement).value)}
            />
          </label>
          <button class="primary-action" disabled={status === 'loading'}>
            {status === 'loading' ? 'Checking access' : 'Sign in'}
          </button>
          {message && <p class="error-note">{message}</p>}
        </form>

        <div class="panel">
          <h2>Session</h2>
          {status === 'signed-in' ? (
            <div class="session-panel">
              <strong>{email}</strong>
              <span>Privileged operations enabled</span>
              <button class="secondary-action" onClick={signOut}>
                Sign out
              </button>
            </div>
          ) : status === 'loading' ? (
            <div class="loading-block">
              <span class="loader" />
              <span>Validating credentials</span>
              <button class="secondary-action" onClick={completeSignIn}>
                Open workspace
              </button>
            </div>
          ) : (
            <p class="muted">Use the access key assigned to this workspace.</p>
          )}
        </div>

        <ErrorBoundary
          fallback={(error, reset) => (
            <div class="panel error-panel">
              <h2>Audit stream unavailable</h2>
              <p>{error.message}</p>
              <button
                class="secondary-action"
                onClick={() => {
                  auditBroken = false
                  reset?.()
                }}
              >
                Reconnect
              </button>
            </div>
          )}
        >
          <AuditStream broken={auditBroken} onBreak={() => (auditBroken = true)} />
        </ErrorBoundary>
      </section>
    </article>
  )
}

function AuditStream(props: { broken: boolean; onBreak: () => void }) {
  return props.broken ? <AuditFailure /> : <AuditPanel onBreak={props.onBreak} />
}

function AuditFailure(): FictNode {
  throw new Error('The audit endpoint returned a 503 response.')
}

function AuditPanel(props: { onBreak: () => void }) {
  return (
    <div class="panel">
      <h2>Audit stream</h2>
      <ul class="audit-list">
        <li>Session token rotated</li>
        <li>Billing export completed</li>
        <li>Admin policy reviewed</li>
      </ul>
      <button class="secondary-action" onClick={props.onBreak}>
        Simulate outage
      </button>
    </div>
  )
}

render(() => <App />, document.getElementById('app')!)
