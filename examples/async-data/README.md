# Fict async data example

Run `pnpm --dir examples/async-data dev` from the repository root. The simulated
fetchers work without a network service.

The users/posts panels use `resource` from `fict/plus` for shared requests, caching,
refresh and reactive keys. Select different users, or refresh the users list;
the current posts continue to follow the selected key.

The **Owned async results** panel uses `$async` in a component. Its synchronous
producer captures the request inputs and passes an abort signal to an ordinary
async helper. The resolved result feeds a plain template-string derivation and
then a JSX binding. There are no separate loading/error signals for that value.

- Enter a local note and choose **Next result**. Suspense temporarily parks the
  content; the same input and its value return when the result is ready.
- Choose **Next result** twice in quick succession. The newer generation owns
  publication and cancellation of the replaced request.
- Choose **Simulate error**, then **Recover result**. ErrorBoundary handles the
  rejection, and its explicit reset key permits a new attempt.
- Choose **Hide async view** during a request. Disposing the view cancels its
  work; showing it again creates a new view starting at result 1.

The transition indicator follows work caused by the transition's state writes.
It does not imply that arbitrary native Promise callbacks inherit a transition
or a reactive owner. The Resource panels and the async result panel have
independent ownership and loading boundaries.

`pnpm test:strict-applications` builds captured production artifacts and checks
these flows in Chromium, including DOM identity, overlapping updates, error
recovery and unmount. The Webpack variant covers the Resource panels separately.
Server streaming and client hydration are exercised by
`pnpm test:async-ssr:browser` and documented in the
[SSR/hydration guide](../../docs/async-ssr-hydration.md).

See the [migration guide](../../docs/async-migration-guide.md) for
ordinary Promise memos, two-phase effects, metadata compatibility and unsupported
native-await/Preview boundaries.
