/**
 * @zakkster/lite-defer -- deferred reactive values for @zakkster/lite-signal.
 *
 * `defer(source)` returns a value that lags its source and catches up on a
 * scheduler, coalescing a synchronous burst into one downstream update.
 */

/** A reactive read. A lite-signal handle satisfies this (it is callable). */
export type Accessor<T> = () => T;

/** Receives a flush thunk and calls it when the deferred value should catch up. */
export type Scheduler = (flush: () => void) => void;

/** Coalesce to the end of the current task. The default scheduler. */
export const microtask: Scheduler;
/** Coalesce to the next animation frame (frame cadence). Falls back to ~16ms. */
export const raf: Scheduler;
/** Coalesce to an idle slot (lowest priority). Falls back to ~1ms. */
export const idle: Scheduler;
/** Build a scheduler that coalesces to a `setTimeout(ms)`. */
export function timeout(ms: number): Scheduler;

export interface DeferOptions<T> {
    /** How to coalesce catch-up. Default: `microtask`. */
    schedule?: Scheduler;
    /** Equality for the deferred value; gates the catch-up. Default: `Object.is`. */
    equals?: (a: T, b: T) => boolean;
}

/** A value that lags its source and catches up on a scheduler. */
export interface Deferred<T> {
    /** The current deferred (lagging) value. */
    (): T;
    /** True from the instant the source moves ahead until the deferred value catches up. */
    pending(): boolean;
    /** Stop tracking and dispose the deferred + staleness signals. Caller owns teardown. */
    dispose(): void;
}

/**
 * A value that lags `source` and catches up on `opts.schedule`. The source is
 * computed eagerly; what is deferred is the work downstream of the returned value.
 * Defer a cheap input upstream of an expensive derivation to defer the derivation.
 */
export function defer<T>(source: Accessor<T>, opts?: DeferOptions<T>): Deferred<T>;

export interface DeferEffectOptions {
    /** How to coalesce runs. Default: `microtask`. */
    schedule?: Scheduler;
}

/**
 * An effect whose runs are coalesced onto a scheduler (at most one run per burst).
 * The initial run is also scheduled. Returns a dispose function.
 */
export function deferEffect(fn: () => void, opts?: DeferEffectOptions): () => void;

/** The subset of a lite-signal registry that createDeferrer binds to (>=1.5.0). */
export interface SignalRegistry {
    signal: (...args: any[]) => any;
    effect: (...args: any[]) => any;
    untrack: (...args: any[]) => any;
    createRoot: (...args: any[]) => any;
    dispose: (...args: any[]) => any;
}

export interface Deferrer {
    defer: typeof defer;
    deferEffect: typeof deferEffect;
}

/**
 * Bind the deferral primitives to an explicit registry. The default exports
 * `defer` / `deferEffect` are bound to the default registry.
 */
export function createDeferrer(reg: SignalRegistry): Deferrer;
