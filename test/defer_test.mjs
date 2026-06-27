import { test } from "node:test";
import assert from "node:assert/strict";
import { signal, effect, stats, dispose } from "@zakkster/lite-signal";
import { defer, deferEffect, createDeferrer, microtask, raf, idle, timeout } from "../Defer.js";

// A scheduler we fire by hand, so lag/coalescing are deterministic (no real timers).
function manualSchedule() {
    let queued = null;
    const schedule = (flush) => { queued = flush; };   // defer coalesces -> at most one
    const fire = () => { const f = queued; queued = null; if (f) f(); };
    return { schedule, fire, get armed() { return queued !== null; } };
}

test("defer seeds synchronously to the source's current value", () => {
    const src = signal(7);
    const d = defer(src, { schedule: manualSchedule().schedule });
    assert.equal(d(), 7, "deferred value is the source value at creation, no flush needed");
    assert.equal(d.pending(), false);
    d.dispose();
});

test("defer lags the source and catches up only when the scheduler fires", () => {
    const m = manualSchedule();
    const src = signal(0);
    const d = defer(src, { schedule: m.schedule });
    src.set(1);
    assert.equal(d(), 0, "deferred value still lags until the scheduler runs");
    assert.equal(d.pending(), true, "pending the instant the source moves ahead");
    m.fire();
    assert.equal(d(), 1, "deferred value caught up");
    assert.equal(d.pending(), false, "no longer pending after catch-up");
    d.dispose();
});

test("defer coalesces a synchronous burst into one downstream update", () => {
    const m = manualSchedule();
    const src = signal(0);
    const d = defer(src, { schedule: m.schedule });
    let runs = 0, seen;
    const stop = effect(() => { runs++; seen = d(); });   // initial run = 1
    src.set(1); src.set(2); src.set(3);
    assert.equal(runs, 1, "no downstream run during the burst");
    assert.equal(m.armed, true, "exactly one flush scheduled");
    m.fire();
    assert.equal(seen, 3, "only the final value crosses the frontier");
    assert.equal(runs, 2, "exactly one downstream run for the whole burst");
    stop(); d.dispose();
});

test("defer: a revert within a burst (A -> B -> A) fires downstream zero times", () => {
    const m = manualSchedule();
    const src = signal("A");
    const d = defer(src, { schedule: m.schedule });
    let runs = 0;
    const stop = effect(() => { runs++; d(); });   // 1
    src.set("B"); src.set("A");                     // reverts before the scheduler fires
    assert.equal(d.pending(), true, "stale while the burst is outstanding");
    m.fire();
    assert.equal(runs, 1, "no downstream run: latest equals the live value, set is skipped");
    assert.equal(d.pending(), false, "pending still clears on catch-up");
    assert.equal(d(), "A");
    stop(); d.dispose();
});

test("defer: custom equals gates the catch-up", () => {
    const m = manualSchedule();
    const src = signal({ id: 1, v: "a" });
    const d = defer(src, { schedule: m.schedule, equals: (a, b) => a.id === b.id });
    let runs = 0;
    const stop = effect(() => { runs++; d(); });   // 1

    src.set({ id: 1, v: "b" });   // same id -> "equal"
    m.fire();
    assert.equal(runs, 1, "equal-by-key catch-up does not fire downstream");

    src.set({ id: 2, v: "c" });   // new id
    m.fire();
    assert.equal(runs, 2, "unequal catch-up fires downstream");
    assert.equal(d().id, 2);
    stop(); d.dispose();
});

test("defer over a multi-signal accessor tracks both inputs", () => {
    const m = manualSchedule();
    const a = signal(1), b = signal(2);
    const d = defer(() => a() + b(), { schedule: m.schedule });
    assert.equal(d(), 3);
    a.set(10);
    assert.equal(d(), 3, "lags");
    m.fire();
    assert.equal(d(), 12);
    b.set(20);
    m.fire();
    assert.equal(d(), 30);
    d.dispose();
});

test("defer: set + catch-up churn is zero-GC", () => {
    const m = manualSchedule();
    const src = signal(0);
    const d = defer(src, { schedule: m.schedule });
    let sink;
    const stop = effect(() => { sink = d() + (d.pending() ? 0 : 0); });
    // warm
    for (let i = 0; i < 5; i++) { src.set(i); m.fire(); }
    const base = stats();
    for (let i = 0; i < 20000; i++) { src.set(i); m.fire(); }
    const after = stats();
    assert.equal(after.poolGrowths - base.poolGrowths, 0, "no pool growth under 20k set+catch-up cycles");
    assert.equal(after.totalAllocations - base.totalAllocations, 0, "no node allocations: fixed signals + effect, stable-order retrack");
    assert.equal(sink, 19999);
    stop(); d.dispose();
});

test("defer.dispose() returns the engine to baseline", () => {
    const base = stats();
    const m = manualSchedule();
    const src = signal(0);
    const d = defer(src, { schedule: m.schedule });
    assert.ok(stats().activeNodes > base.activeNodes);
    src.set(1);                  // arm a flush
    d.dispose();
    dispose(src);
    assert.equal(stats().activeNodes, base.activeNodes, "deferred + stale signals and the tracking effect all disposed");
});

test("defer.dispose() before an armed flush fires is a safe no-op", () => {
    const m = manualSchedule();
    const src = signal(0);
    const d = defer(src, { schedule: m.schedule });
    src.set(5);
    assert.equal(m.armed, true);
    d.dispose();
    assert.doesNotThrow(() => m.fire(), "flushing after dispose does not throw");
});

test("deferEffect coalesces runs onto the scheduler", () => {
    const m = manualSchedule();
    const a = signal(0);
    let runs = 0, seen;
    const stop = deferEffect(() => { runs++; seen = a(); }, { schedule: m.schedule });
    // initial run is scheduled (engine semantics)
    assert.equal(runs, 0, "initial run is deferred to the scheduler");
    m.fire();
    assert.equal(runs, 1);
    assert.equal(seen, 0);
    a.set(1); a.set(2);          // burst
    assert.equal(runs, 1, "no run during the burst");
    m.fire();
    assert.equal(runs, 2);
    assert.equal(seen, 2, "ran once with the final value");
    stop();
});

test("microtask scheduler defers across the task boundary", async () => {
    const src = signal(0);
    const d = defer(src);   // default = microtask
    src.set(1);
    assert.equal(d(), 0, "synchronously still lagging");
    assert.equal(d.pending(), true);
    await Promise.resolve();
    assert.equal(d(), 1, "caught up after the microtask");
    assert.equal(d.pending(), false);
    d.dispose();
});

test("timeout scheduler defers across a real timer", async () => {
    const src = signal(0);
    const d = defer(src, { schedule: timeout(5) });
    src.set(42);
    assert.equal(d(), 0);
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(d(), 42, "caught up after the timeout");
    d.dispose();
});

test("named schedulers are functions; timeout is a factory", () => {
    assert.equal(typeof microtask, "function");
    assert.equal(typeof raf, "function");
    assert.equal(typeof idle, "function");
    assert.equal(typeof timeout(10), "function");
});

test("createDeferrer binds to an explicit registry", async () => {
    const mod = await import("@zakkster/lite-signal");
    const { defer: d2 } = createDeferrer(mod);
    const m = manualSchedule();
    const src = signal(1);
    const d = d2(src, { schedule: m.schedule });
    assert.equal(d(), 1);
    src.set(2); m.fire();
    assert.equal(d(), 2);
    d.dispose();
});
