import { Suspense, createSuspenseToken, type FictNode } from 'fict'

interface DeferredState {
  ready: boolean
  token: ReturnType<typeof createSuspenseToken>
}

function createDeferredState(delay: number): DeferredState {
  const state = {
    ready: false,
    token: createSuspenseToken(),
  }
  setTimeout(() => {
    state.ready = true
    state.token.resolve()
  }, delay)
  return state
}

export function createStreamingApp() {
  const revenue = createDeferredState(120)
  const incidents = createDeferredState(220)

  function RevenuePanel(): FictNode {
    if (!revenue.ready) throw revenue.token.token
    return (
      <section class="panel">
        <p class="eyebrow">Revenue</p>
        <strong class="large-number">$612k</strong>
        <span>Weekly committed pipeline</span>
      </section>
    )
  }

  function IncidentPanel(): FictNode {
    if (!incidents.ready) throw incidents.token.token
    return (
      <section class="panel">
        <p class="eyebrow">Incidents</p>
        <strong class="large-number">29</strong>
        <span>Open across production workspaces</span>
      </section>
    )
  }

  return function StreamingPage() {
    return (
      <main class="stream-page">
        <header class="masthead">
          <p class="eyebrow">Regional control</p>
          <h1>Operations command center</h1>
          <p>Live deployment telemetry for the current release window.</p>
        </header>

        <section class="summary-grid">
          <Suspense fallback={<PanelSkeleton label="Revenue" />}>
            <RevenuePanel />
          </Suspense>
          <Suspense fallback={<PanelSkeleton label="Incidents" />}>
            <IncidentPanel />
          </Suspense>
        </section>

        <section class="timeline">
          <h2>Deployment timeline</h2>
          <ol>
            <li>
              <strong>14:00</strong>
              <span>Canary build promoted to regional edge.</span>
            </li>
            <li>
              <strong>14:06</strong>
              <span>Readiness probes stable across all zones.</span>
            </li>
            <li>
              <strong>14:18</strong>
              <span>Traffic ramp moved from 15% to 50%.</span>
            </li>
          </ol>
        </section>
      </main>
    )
  }
}

function PanelSkeleton(props: { label: string }) {
  return (
    <section class="panel skeleton">
      <p class="eyebrow">{props.label}</p>
      <span class="skeleton-line wide" />
      <span class="skeleton-line" />
    </section>
  )
}
