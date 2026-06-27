# Changelog

All notable changes to `@zakkster/lite-defer` are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/).

## [1.0.0] -- 2026-06-XX

Initial public release. Deferred reactive values for `@zakkster/lite-signal`: a
concurrency frontier where a value lags its source and catches up on a scheduler,
coalescing a synchronous burst into one downstream update.

### Added -- `defer(source, opts?)`

A value that lags `source` and catches up on `opts.schedule`.

- **Seeds synchronously** to the source's current value; reads before the first
  catch-up return the live value. Lags on subsequent change; catches up to the
  **latest** value when the scheduler fires, **coalescing** a burst (any number of
  synchronous `set`s) into a single downstream update.
- **`pending()`** -- a reactive boolean, true the instant the source moves ahead
  (synchronous), false again when the deferred value catches up. The frontier
  indicator for stale content.
- `opts.schedule` -- `(flush) => void`, default `microtask`. `opts.equals` --
  equality for the deferred value, gating the catch-up, default `Object.is`.
- Returns a callable accessor with `pending()` and `dispose()`.

Model A (`useDeferredValue`): the source is computed eagerly; what is deferred is
the work downstream of the deferred value. To defer an expensive **derivation**,
defer its cheap input and derive from the deferred value.

### Added -- schedulers

- **`microtask`** (default) -- coalesce to the end of the current task; no host APIs.
- **`raf`** -- coalesce to the next animation frame (frame cadence); falls back to a
  ~16ms timeout where `requestAnimationFrame` is absent.
- **`idle`** -- coalesce to an idle slot (lowest priority); falls back to ~1ms.
- **`timeout(ms)`** -- factory; coalesce to a `setTimeout(ms)` (debounce cadence).
- Any `(flush) => void` works, including lite-raf's frame scheduler.

### Added -- `deferEffect(fn, opts?)`

An effect whose runs are coalesced onto a scheduler (at most one run per burst,
e.g. once per frame). The initial run is also scheduled. A thin, named wrapper over
the engine's `effect(fn, { scheduler })` so the named schedulers have a home and
the pattern reads clearly.

### Added -- `createDeferrer(registry)`

Binds `defer` / `deferEffect` to an explicit registry. The default exports are
bound to the default registry.

### Design notes

- Built on the ecosystem's `schedule: (flush) => void` coalescing convention (the
  same shape lite-channel and lite-query use), not on the engine's scheduled-effect
  path for the value, so the deferred value seeds synchronously and `pending` is
  exact. (The engine schedules an effect's *initial* run too, which would delay the
  seed; `defer` seeds eagerly and drives catch-up with a plain tracking effect.)
- `defer`'s internals are detached (`createRoot`), so an enclosing scope re-running
  never tears the deferred value down. The caller owns teardown via `dispose()`.

### Dependency

- Peer `@zakkster/lite-signal` `^1.5.0` (uses `createRoot`). Does not require
  `createScope` / 1.6.0.

### Zero-GC, verified

- A churn of source-`set` + catch-up -- 20,000 cycles -- is flat on the engine's
  pool counters (`poolGrowths` / `totalAllocations`): the deferred signal,
  staleness signal, tracking effect, and flush thunk are fixed; the effect
  re-tracks on a stable read order (cursor reuse); both signal sets are
  allocation-free.
- **Honest non-claim:** the scheduler's own queue entry (a microtask, a `rAF`
  callback, a timer) is the host's, not the engine pool's. `defer` does not defer
  the source's own computation (model A) -- defer a cheap input upstream to defer
  the work.

### Tested

- 13 tests under `node --test --expose-gc`: synchronous seed; lag + catch-up;
  burst coalescing; `pending` transitions; custom-`equals` gating; multi-signal
  accessor; set+catch-up zero-GC (20k); `dispose` to baseline; dispose-before-flush
  safety; `deferEffect` coalescing; the `microtask` and `timeout` schedulers across
  real async boundaries; scheduler shapes; `createDeferrer` binding.
- ESM only; `node:test`; `sideEffects: false`; ASCII source; `Defer.d.ts` validated
  under `tsc --strict`.
