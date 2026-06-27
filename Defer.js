/**
 * @zakkster/lite-defer v1.0.0 -- deferred reactive values for @zakkster/lite-signal.
 * -----------------------------------------------------------------------------
 * A concurrency frontier in the reactive graph: `defer(source)` returns a value
 * that LAGS its source and catches up on a scheduler, coalescing a synchronous
 * burst into a single downstream update. Urgent consumers read the source
 * directly and see every change immediately; expensive consumers read the
 * deferred value and update on the scheduler's cadence (a frame, an idle slot,
 * a microtask) instead of on every set. This is `useDeferredValue` / Solid's
 * `createDeferred` for lite-signal -- model A: the source is computed eagerly;
 * what the frontier defers is the WORK DOWNSTREAM of the deferred value.
 *
 * To defer an expensive DERIVATION, defer its cheap input and derive from the
 * deferred value:
 *     const q = defer(rawQuery);                       // cheap signal, deferred
 *     const results = computed(() => search(q()));     // search runs on q's cadence
 *
 * `pending()` is the frontier indicator: true the instant the source moves ahead,
 * false again when the deferred value catches up -- the hook for dimming stale
 * content or showing a spinner while the heavy update is in flight.
 *
 * -- SCHEDULERS --
 * A scheduler is `(flush: () => void) => void`: it receives a flush thunk and
 * calls it when the deferred value should catch up. Coalescing is built in --
 * `defer` schedules at most one flush per burst. Provided: `microtask` (default),
 * `raf` (frame cadence), `idle`, and `timeout(ms)`. Any `(flush) => void` works,
 * including lite-raf's frame scheduler.
 *
 * -- ZERO-GC --
 * The deferred signal, the staleness signal, the tracking effect, and the flush
 * thunk are all fixed per `defer`. A churn of source-set + catch-up allocates
 * nothing on the engine pool (the tracking effect re-tracks on a stable read
 * order -> cursor reuse; both signal sets are allocation-free). Honest non-claim:
 * the scheduler's own queue entry (a microtask, a rAF callback) is the host's,
 * not the engine pool's.
 *
 * -- OWNERSHIP --
 * `defer`'s internals are detached (createRoot), so an enclosing scope re-running
 * never tears the deferred value down. The caller owns teardown: the returned
 * accessor carries a `.dispose()`. Call `defer` once at setup.
 *
 * Registry-parametric: createDeferrer(reg) binds to any registry exposing
 * createRoot (>=1.5.0). Default-bound `defer` / `deferEffect` are exported.
 *
 * DOM-free core. MIT (c) 2026 Zahary Shinikchiev
 */

import {
    signal as _signal,
    effect as _effect,
    untrack as _untrack,
    createRoot as _createRoot,
    dispose as _dispose,
} from "@zakkster/lite-signal";

// ---- schedulers --------------------------------------------------------------

/** Coalesce to the end of the current task. The universal default; no host APIs. */
export const microtask = (flush) => queueMicrotask(flush);

/** Coalesce to the next animation frame (frame cadence). Falls back to a ~16ms
 *  timeout where requestAnimationFrame is absent (Node / SSR). */
export const raf = (flush) => {
    const g = globalThis;
    if (typeof g.requestAnimationFrame === "function") g.requestAnimationFrame(flush);
    else setTimeout(flush, 16);
};

/** Coalesce to an idle slot (lowest priority). Falls back to a ~1ms timeout. */
export const idle = (flush) => {
    const g = globalThis;
    if (typeof g.requestIdleCallback === "function") g.requestIdleCallback(flush);
    else setTimeout(flush, 1);
};

/** Build a scheduler that coalesces to a `setTimeout(ms)` (a debounce cadence). */
export const timeout = (ms) => (flush) => setTimeout(flush, ms);

/**
 * Bind the deferral primitives to a registry.
 * @param {{signal:Function, effect:Function, untrack:Function, createRoot:Function, dispose:Function}} reg
 * @returns {{defer:Function, deferEffect:Function}}
 */
export function createDeferrer(reg) {
    const signal = reg.signal;
    const effect = reg.effect;
    const untrack = reg.untrack;
    const createRoot = reg.createRoot;
    const dispose = reg.dispose;

    /**
     * A value that lags `source` and catches up on `schedule`.
     * @param {() => unknown} source Reactive source (accessor/signal).
     * @param {{schedule?:(flush:()=>void)=>void, equals?:(a:unknown,b:unknown)=>boolean}} [opts]
     * @returns {(() => unknown) & { pending: () => boolean, dispose: () => void }}
     */
    function defer(source, opts) {
        const schedule = (opts && opts.schedule) || microtask;
        const eqOpt = opts && opts.equals;
        const eq = eqOpt || Object.is;

        let valueSig;          // the deferred value (lags source)
        let staleSig;          // true while source is ahead of the deferred value
        let stop;              // tracking-effect disposer
        let latest;            // most recent source value (captured synchronously)
        let primed = false;    // first effect run only seeds tracking
        let scheduled = false; // at most one flush in flight per burst
        let disposed = false;

        const flush = () => {
            scheduled = false;
            if (disposed) return;
            // Early-exit a no-op catch-up: a burst that reverts (A -> B -> A) before
            // the scheduler fires leaves `latest` equal to the live value. The
            // signal's own `equals` would already suppress the downstream run; this
            // skips the set call entirely. Uses the CONFIGURED equality so it agrees
            // with how `valueSig` dedups.
            if (!eq(latest, valueSig.peek())) valueSig.set(latest);
            staleSig.set(false);
        };

        createRoot(() => {
            latest = untrack(source);
            valueSig = eqOpt ? signal(latest, { equals: eqOpt }) : signal(latest);
            staleSig = signal(false);
            stop = effect(() => {
                latest = source();              // track source; capture the latest value
                if (!primed) { primed = true; return; }   // initial run: value already seeded
                staleSig.set(true);             // source moved ahead -> stale now (synchronous)
                if (!scheduled) { scheduled = true; schedule(flush); }
            });
        });

        const read = () => valueSig();
        read.pending = () => staleSig();
        read.dispose = () => {
            if (disposed) return;
            disposed = true;
            stop();
            dispose(valueSig);
            dispose(staleSig);
        };
        return read;
    }

    /**
     * An effect whose runs are coalesced onto a scheduler -- runs at most once per
     * burst on the scheduler's cadence (e.g. once per frame). The INITIAL run is
     * also scheduled (the engine's scheduled-effect semantics).
     * @param {() => void} fn
     * @param {{schedule?:(flush:()=>void)=>void}} [opts]
     * @returns {() => void} dispose
     */
    function deferEffect(fn, opts) {
        const schedule = (opts && opts.schedule) || microtask;
        return effect(fn, { scheduler: schedule });
    }

    return { defer, deferEffect };
}

const _d = createDeferrer({
    signal: _signal,
    effect: _effect,
    untrack: _untrack,
    createRoot: _createRoot,
    dispose: _dispose,
});

export const defer = _d.defer;
export const deferEffect = _d.deferEffect;
