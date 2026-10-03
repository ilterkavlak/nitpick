import { test } from "node:test";
import assert from "node:assert/strict";
import { setupStdin, type StdinLike } from "./dashboard";

// Regression guard for the interactive-mode hang.
//
// The dashboard calls stdin.resume() + stdin.on("data", ...) to intercept
// Ctrl+C in raw mode, which ref-counts stdin onto the event loop. If the
// teardown path doesn't pause stdin, the process stays alive after
// runReview() resolves because nothing else pauses stdin back.
//
// Previously the teardown was `if (wasPaused) stdin.pause()` — which
// silently no-op'd whenever inquirer had left stdin resumed before the
// dashboard started (the common interactive flow). These tests lock down
// the invariant that teardown always pauses stdin and always removes the
// data listener.

interface FakeStdin extends StdinLike {
  listeners: Array<(chunk: Buffer | string) => void>;
  resumeCount: number;
  pauseCount: number;
  rawCalls: boolean[];
  paused: boolean;
}

function makeStdin(opts: { isTTY?: boolean; initiallyPaused?: boolean; initiallyRaw?: boolean } = {}): FakeStdin {
  const stdin: FakeStdin = {
    isTTY: opts.isTTY ?? true,
    isRaw: opts.initiallyRaw ?? false,
    paused: opts.initiallyPaused ?? false,
    listeners: [],
    resumeCount: 0,
    pauseCount: 0,
    rawCalls: [],
    setRawMode(mode: boolean) {
      stdin.rawCalls.push(mode);
      stdin.isRaw = mode;
      return stdin;
    },
    isPaused() {
      return stdin.paused;
    },
    resume() {
      stdin.resumeCount++;
      stdin.paused = false;
      return stdin;
    },
    pause() {
      stdin.pauseCount++;
      stdin.paused = true;
      return stdin;
    },
    on(_event, listener) {
      stdin.listeners.push(listener);
      return stdin;
    },
    removeListener(_event, listener) {
      const i = stdin.listeners.indexOf(listener);
      if (i >= 0) stdin.listeners.splice(i, 1);
      return stdin;
    },
  };
  return stdin;
}

test("setupStdin: teardown pauses stdin even when it started resumed", () => {
  // This is the exact interactive-mode scenario that used to hang:
  // inquirer returns with stdin resumed, dashboard starts (wasPaused=false),
  // dashboard stops — previously we never paused. Now we must.
  const stdin = makeStdin({ initiallyPaused: false });

  const restore = setupStdin(stdin);
  assert.ok(restore, "setupStdin should return a restore fn for a TTY");

  assert.equal(stdin.resumeCount, 1, "setup should resume stdin");
  assert.equal(stdin.listeners.length, 1, "setup should add one data listener");

  restore!();

  assert.equal(stdin.pauseCount, 1, "restore MUST pause stdin or the process hangs on exit");
  assert.equal(stdin.paused, true);
  assert.equal(stdin.listeners.length, 0, "restore must remove the data listener");
});

test("setupStdin: teardown pauses stdin even when it started paused", () => {
  // The old code DID pause in this case (wasPaused=true). Keep it working
  // so we don't regress the easy path while fixing the hard one.
  const stdin = makeStdin({ initiallyPaused: true });

  const restore = setupStdin(stdin);
  assert.ok(restore);

  restore!();

  assert.equal(stdin.pauseCount, 1);
  assert.equal(stdin.paused, true);
});

test("setupStdin: teardown restores the prior raw mode", () => {
  const stdin = makeStdin({ initiallyRaw: false });

  const restore = setupStdin(stdin);
  assert.deepEqual(stdin.rawCalls, [true], "setup switches into raw mode");

  restore!();

  assert.deepEqual(
    stdin.rawCalls,
    [true, false],
    "restore should flip raw mode back to its prior value"
  );
});

test("setupStdin: returns null for non-TTY stdin (piped/ref-mode)", () => {
  const stdin = makeStdin({ isTTY: false });
  const restore = setupStdin(stdin);
  assert.equal(restore, null);
  assert.equal(stdin.resumeCount, 0, "must not touch stdin when not a TTY");
  assert.equal(stdin.listeners.length, 0);
});

test("setupStdin: returns null if setRawMode is unavailable", () => {
  const stdin = makeStdin({ isTTY: true });
  // Simulate a stream where setRawMode is missing (not a real TTY)
  (stdin as { setRawMode?: unknown }).setRawMode = undefined;
  const restore = setupStdin(stdin);
  assert.equal(restore, null);
});

test("setupStdin: Ctrl+C byte in stdin data triggers SIGINT self-raise", () => {
  // Raw mode disables kernel translation of Ctrl+C, so the dashboard has to
  // recognise the 0x03 byte itself and re-raise SIGINT. This test pins the
  // behaviour so nobody accidentally removes it during a refactor.
  const stdin = makeStdin();
  const restore = setupStdin(stdin);
  assert.ok(restore);

  let raised: NodeJS.Signals | null = null;
  const origKill = process.kill.bind(process);
  (process as { kill: typeof process.kill }).kill = ((pid: number, sig?: NodeJS.Signals | number) => {
    if (pid === process.pid && sig === "SIGINT") {
      raised = "SIGINT";
      return true;
    }
    return origKill(pid, sig);
  }) as typeof process.kill;

  try {
    // Deliver a Ctrl+C byte through the installed listener.
    stdin.listeners[0]!(Buffer.from([0x03]));
    assert.equal(raised, "SIGINT", "Ctrl+C (0x03) in raw mode must re-raise SIGINT");
  } finally {
    (process as { kill: typeof process.kill }).kill = origKill;
    restore!();
  }
});
