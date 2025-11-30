# Fiction UI: Think About Your "Fiction Layer" Before Designing UI

> **UI is fiction. Your data is real.**
> Fict treats the interface as a layer of "elaborate fiction" built on top of real state.

Most frameworks treat UI as "something rendered by components."
Fict deliberately separates "**what is really happening**" from "**the world the user sees**":

- **Reality**: Database, API, business rules, permissions, logs...
- **Fiction**: Loading skeletons, error messages, progressive loading, optimistic updates, delayed animations, soft onboarding...

This layer of fiction isn't just "styles written along the way," but the **story** you are truly telling the user.

---

## 1. What is Fiction UI?

Let's use an example:

```ts
// The Real World
const user = {
  id: '42',
  tier: 'free',
  credit: 0,
  banned: false,
}
```

If you render these fields directly:

```tsx
<p>tier: free</p>
<p>credit: 0</p>
<p>banned: false</p>
```

This has almost no UX and absolutely no "storytelling."

A real product UI looks more like this:

* If the user just logged in, show a **Welcome Panel + Loading Skeleton**.
* If credits are exhausted, show a **gentle but clear upgrade prompt**.
* If banned, show a **calm, clear explanation + contact channel**.
* If everything is normal, proceed to the main task flow.

**With the same state**, you can tell completely different stories.

Fict wants you to explicitly write this "fiction logic" instead of burying it in scattered `if (loading)`, `try/catch`, and various UI framework DSLs.

---

## 2. Three Questions for the Fiction Layer

In Fict, you can constantly ask yourself three questions when writing UI:

1. **What should the user believe right now?**

   * "Data is loading."
   * "Your action has taken effect (even if not yet written to the backend)."
   * "You don't need to care about this complexity for now."

2. **What real details are we temporarily hiding?**

   * Network jitter / retry mechanisms.
   * Chunked loading.
   * Permission calculations.
   * Complex business rules behind decisions.

3. **How does this fiction change with real state?**

   * From skeleton → partial data → fully loaded.
   * From optimistic state → success confirmation or rollback.
   * From "trial available" → "strong upgrade prompt".

These three questions are exactly what Fict wants to help you express clearly in your code.

---

## 3. Fict's Philosophy: Only Mark "Mutable" and "Effect-Producing"

Fict's design principles can be summarized in one sentence:

> **Only mark: things that change ($state) and things that produce effects ($effect); the rest is plain TypeScript.**

### 3.1 Mutable: $state

```ts
let credit = $state(0)
let loading = $state(true)
let error = $state<string | null>(null)
```

* These are part of the "real world" (or an abstraction of it).
* Their changes drive the next frame of the entire "fiction story."

In Fict, they "look like" normal variables:

* `credit++`
* `loading = false`
* `error = 'Network error'`

You don't need to remember `setXXX`, use `.value`, or `signal()` / `()`.

### 3.2 Effect-Producing: $effect

```ts
$effect(() => {
  document.title = loading ? 'Loading…' : `Credits: ${credit}`
})
```

* `$effect` tells Fict: this touches the DOM / Network / Logs / Global Objects...
* They are automatically dependency-tracked, automatically cleaned up, and automatically re-executed.

These are Fict's **two "special statements"**:

* *"This might change"* → `$state`
* *"This spills over into the world"* → `$effect`

Everything else: **if / for / switch / destructuring / string concatenation / function calls / module exports... is all plain TypeScript.**

---

## 4. What the Fiction Layer Looks Like in Code

Let's look at a slightly more complete example:

```tsx
import { $state, $effect } from 'fict'

export function CreditsPanel({ userId }: { userId: string }) {
  let credit = $state<number | null>(null)
  let loading = $state(true)
  let error = $state<string | null>(null)

  const needsUpgrade = credit !== null && credit <= 0
  const showSkeleton = loading && credit === null && !error

  $effect(() => {
    loading = true
    error = null
    fetch(`/api/credits/${userId}`)
      .then(r => r.json())
      .then(data => {
        credit = data.credit
        loading = false
      })
      .catch(e => {
        error = 'Failed to load credits'
        loading = false
      })
  })

  if (showSkeleton) {
    return <SkeletonPanel />
  }

  if (error) {
    return <ErrorPanel message={error} />
  }

  if (needsUpgrade) {
    return <UpsellPanel credit={credit ?? 0} />
  }

  return <MainPanel credit={credit ?? 0} />
}
```

The "fiction" here consists of these branches:

* `SkeletonPanel`: Tells the user "something is on the way."
* `ErrorPanel`: Tells the user "there's a problem, but it's not your fault."
* `UpsellPanel`: Tells the user "you've gotten value, now it's time to upgrade."
* `MainPanel`: Enters the real task flow.

Notice the way the entire component is written:

* No hook call order restrictions.
* No template DSL (`v-if`, `{#if}`).
* No `useMemo` / `computed` / `$derived`.
* Only `$state` + `$effect` + plain TypeScript.

This is the Fict "fiction-first" experience: **You are almost writing a product requirement document in TypeScript.**

---

## 5. Comparison with Traditional "View-first" Models

The default mindset of most frameworks is:

> There is a state tree → I write a component tree → The framework is responsible for "rendering state into a view."

Fict deliberately emphasizes an extra layer:

> There is a real state tree → I write a "story the user should see" →
> This story is then compiled into concrete DOM operations and state graphs.

The concrete differences this brings:

| Aspect | Traditional View-first | Fict (Fiction-first) |
| :--- | :--- | :--- |
| **Primary Thinking Object** | Component Tree / Templates | User Story / Fiction Layer |
| **What You Write** | "Put a component here, render a list there" | "Under this real state, which narrative should the user see" |
| **Expressing Complex Logic** | Nested conditions in templates / Various hooks / Specific syntax | Plain TypeScript branches / Variables / Derived expressions |
| **Relationship between State and UI** | UI = render(state) | UI = fiction(realState) (then compiled to render behavior) |
| **Readability** | Heavily relies on familiarity with framework DSL | Depends on whether you can write the user story clearly (language is almost pure TS) |

---

## 6. Practical Advice for Fiction UI

### 6.1 Write the "Story" First, Then the "Implementation"

When using Fict, try writing the "story" in pseudocode first:

```ts
// Pseudocode: Don't rush to write JSX
if (isFirstLoad) {
  Show Skeleton Screen
} else if (loadFailed) {
  Show Error Message + Retry Button
} else if (insufficientCredit) {
  Show Upgrade Prompt
} else {
  Show Normal Main Interface
}
```

Then translate it almost one-to-one into TypeScript:

```ts
const isInitialLoad = loading && credit === null && !error
if (isInitialLoad) return <SkeletonPanel />

if (error) return <ErrorPanel message={error} />

const needsUpgrade = credit !== null && credit <= 0
if (needsUpgrade) return <UpsellPanel credit={credit!} />

return <MainPanel credit={credit!} />
```

This is the typical workflow of Fiction UI.

### 6.2 Switch from "System State" to "User State"

Habitually, we often write conditions like:

* `if (isFetching)`
* `if (hasError)`
* `if (!data.length)`

In Fict, "User Perspective" naming and branching are more encouraged:

* `isFirstLoad` / `isReload`
* `isBlocked` / `isSuspicious` / `isLimited`
* `shouldShowEmptyState`
* `shouldExplainUpgrade`

This way, when reading the code, what pops into your mind is:

> "Oh, right now this person should be seeing the *xxx* state."

Instead of:

> "Is this `loading && !loaded`, or a combination of `loading && loaded`?"

### 6.3 Treat "Fiction Logic" as Refactorable Assets

Truly mature products often constantly polish these fiction layers:

* Loading animations go from global spinner → local skeleton → chunked skeleton.
* Error messages go from "Error" → "You can try refreshing / contacting someone."
* Upgrade prompts go from hard ads → soft notifications → dynamic A/B testing.

Fict's goal is to let this kind of evolution:

* Not require rewriting the "Real World" data model.
* Not require massive changes to template / JSX.
* Mostly just involve changing some high-level conditions and derived variables.

---

## 7. What Does This Have to Do with "Compilers" and "Reactivity Systems"?

Fict's philosophy is **language level as plain as possible, semantic level as smart as possible**:

* You write the **fiction layer** in "plain TypeScript";
* The compiler works in the background:

  * Finds `$state`
  * Finds all expressions dependent on `$state`
  * Analyzes control flow, grouping related logic into reasonable "story blocks"
  * Connects these story blocks into a dependency graph
  * Finally generates runtime code for "fine-grained DOM updates"

So:

* For you: The focus is "how to write a clear story";
* For Fict: The focus is "how to execute this story efficiently while preserving semantics."

If you want to see more details on the internal implementation, you can continue reading
👉 [`docs/architecture.md`](./architecture.md).

---

## 8. When is Fict's Fiction Model Not Suitable?

To be honest, Fiction UI also has unsuitable scenarios, such as:

* Purely static content sites with almost no state/interaction—a simple static site generator might be more appropriate here.
* Heavy Canvas / WebGL / Game Engine level interactions requiring full control over the rendering pipeline.
* You just need a "library that renders React components" and don't care about the overall narrative and data model.

Fict's advantages lie in:

* You are willing to put thought into "what kind of fictional world the user sees."
* The business has high requirements for UX like "loading / error / permissions / upgrades / state transitions."
* At the same time, you want to retain the engineering advantages of TypeScript / JSX.

If you have such needs, the Fiction UI model is very much worth a try.