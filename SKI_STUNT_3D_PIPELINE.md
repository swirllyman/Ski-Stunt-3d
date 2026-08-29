# Ski Stunt 3D — Pipeline & Workflow

**Status:** Built. The debug panel, the bug-capture format and the headless smoke test are in place, and the first playable gameplay slice rides on top of them.

**Goal:** ship a browser game end-to-end from a phone, with no desktop in the loop after a one-time setup, and with Claude doing the actual authoring.

**Device:** Pixel 10, Android.

---

## 0. Overview

Three things happen in a cycle, and each has one tool that owns it.

Design happens by voice. The game runs in Chrome on the same phone, so a live session can be a play session — play, spot something, talk it through, capture it. Design output is a written spec.

Building happens in Claude Code, in the cloud. It reads the spec, writes the code, runs a headless check, and pushes.

Verifying happens in Chrome again, against the deployed Pages build. Numbers that need dozens of passes are not verified this way — they go on the debug panel and are tuned live at zero latency.

The deliberate trade-off: **phone-native and fully agentic beats fast.** A two-minute deploy is acceptable. Needing a laptop is not.

---

## 1. The Loop

```
Voice session with Claude  →  design, grill, refine spec
        ↓ (manual paste — the one handoff step)
Claude Code (web session, Claude mobile app)  →  clones repo, writes code,
                                                  runs smoke test, pushes branch
        ↓
GitHub mobile  →  review + merge  (batch several changes per merge)
        ↓
GitHub Pages rebuild (~30s–2min)
        ↓
Chrome on phone → open Pages URL, play
        ↓
Live play session with Claude → capture bugs and feel notes as they happen
        ↓
back to the top
```

Everything above happens on the phone. Nothing requires a laptop once set up.

---

## 2. Roles of Each Tool

| Tool | Role | Why not something else |
|---|---|---|
| **Claude voice session** | Design thinking, scoping, grilling, spec refinement, live bug capture during play | Fast, hands-free, good for judgement calls |
| **Claude Code (web)** | Writes code, runs the headless smoke test, pushes | Runs in Anthropic's cloud — phone can be pocketed mid-run |
| **GitHub mobile app** | Review, merge, issue writing | Only mobile-native way to manage the repo |
| **Chrome** | Playing the build, tuning via debug panel | GitHub mobile shows raw files, won't render HTML |

### Known limitation

Claude in a voice session **cannot** write to the repo or hand the spec to Claude Code directly. There is no cross-interface handoff. **One manual paste per loop** is the tax. Everything else is automated.

Claude Code likewise **cannot see the game**. It has no eyes, and it cannot tell you whether something looks right or feels right. What it turns out to have, in the cloud environment as configured, is a headless Chromium — enough to prove that the page loads, holds a WebGL context and keeps rendering, and enough to drive the simulation and read numbers back out of it. That is a much stronger floor than "the file parses", and it is still nowhere near "it feels good". See section 8.

---

## 3. Subscription Tiers

- **Claude Pro ($20/mo)** — includes Claude Code, including the web version. Sufficient for this project. Ceiling is only hit on long grinding agentic sessions.
- **Claude Max ($100/mo)** — adds **Remote Control**, the mobile mode for driving a Claude Code session running elsewhere. Not required here.

**Recommendation:** start on Pro. Upgrade only if usage limits actually bite.

---

## 4. One-Time Setup

Best done once on a desktop if one is available; otherwise doable via GitHub mobile web with some patience.

1. Create repo `swirllyman/Ski-Stunt-3d`.
2. Add a single `index.html` at repo root (the whole game lives here).
3. Repo Settings → Pages → deploy from branch (`main`, root). No Actions workflow needed for a single static file.
4. Confirm `https://swirllyman.github.io/Ski-Stunt-3d/` serves. The repo is `Ski-Stunt-3d`, mixed case — the Pages path follows the repo name, so bookmark the one that actually resolves.
5. Connect the repo to Claude Code so web sessions can clone it.
6. Commit `SKI_STUNT_3D_PIPELINE.md` and `SKI_STUNT_3D_GAME_SPEC.md` at repo root.

After this, the phone is self-sufficient.

---

## 5. Why the Single-File Architecture

This is a **pipeline decision as much as a technical one**.

- No Vite, no npm, no build step → nothing that needs a terminal.
- Three.js and Cannon-es loaded from CDN via import maps.
- One file to commit, review, and diff on a phone screen.
- Pages serves it directly with no build stage, minimizing deploy latency.
- One file is also one paste, which is what makes the optional local-editor escape hatch viable.

The React/TypeScript/Vite stack in the original handoff doc is **abandoned** — it's a desktop-shaped toolchain and buys nothing for a single-canvas game.

`tools/` is the one exception to "one file". It holds the smoke test, which is developer tooling and never ships to the browser. It has no dependencies and needs no install step.

### Code style constraints inside index.html

The smoke test has no JavaScript parser available to it (see section 8), so it reads the source with a scanner rather than an AST. Two rules keep that scanner honest, and both are cheap:

- **No `class` bodies.** Use factory functions and closures. A method name inside a class body is indistinguishable from a call to an undefined function without a real parser.
- **No object-literal method shorthand.** Write `foo: () => {}`, not `foo() {}`, for the same reason.

Neither has cost us anything so far. If either ever does, the answer is to vendor a parser into `tools/`, not to weaken the check.

---

## 6. The Debug Panel

The single highest-leverage piece of the entire pipeline. Deploy latency only hurts when hunting one number; the panel removes that case entirely.

### The config object rule

Every tunable number in the game lives in one `CONFIG` object at the top of the file. The panel reads and writes that object directly — it never holds its own copy of a value. Nothing outside `CONFIG` is tunable, and nothing in `CONFIG` is hardcoded elsewhere. If these two drift apart, the panel is worse than useless.

Smoke-test check 4 enforces both directions of this: every path the panel names must exist in `CONFIG`, and every leaf in `CONFIG` must be read somewhere in the game as `CONFIG.<section>.<key>`. A value you add and forget to wire up fails the build.

### Activation

Hidden by default. Shown when the URL carries `?debug=1`. This keeps the shareable build clean while making the panel one URL edit away.

```
https://swirllyman.github.io/Ski-Stunt-3d/?debug=1
```

### Layout

Collapsible overlay, top corner, above the canvas. Touch-first: large slider hit targets, current value shown numerically beside each slider, collapsible section headers. It will be operated by thumb on a phone while the game is running.

A value that has been moved away from the committed one turns amber, so a long tuning session stays readable. A `↻` beside a parameter name means changing it restarts the run (terrain and rig geometry are built once, not per frame).

### Sections and parameters

| Section | Parameters |
|---|---|
| **Physics** | gravity, ground friction, restitution, air drag, angular drag, solver iterations, fixed step, substep cap, contact stiffness, contact relaxation |
| **Skis** | lateral grip, grip limit, glide drag, edge steer, carve response, pop impulse, tuck drag scale, contact tolerance, ankle align, bank angle |
| **Ragdoll rig** | muscle stiffness, muscle damping, joint limit, twist limit, limb mass scale, torso mass scale, limp stiffness, lean torque, air spin torque, max angular speed, balance damping |
| **Animation** | blend duration, landing blend, airborne delay, grounded delay, crash impact, crash hold time, upright minimum, fallen delay, stall speed |
| **Camera** | follow distance, follow height, follow lag, field of view, look ahead, speed pullback |
| **Terrain** | slope angle, width, length, element size, bump amplitude, bump scale, ramp spacing/height/length/width, wall height, tree density, tree spread, seed |
| **World** | fog density, sun elevation, ambient level |

Add to this table as mechanics land. Anything tuned more than twice by hand belongs here.

### Units, because they are not obvious

Every gain under **Ragdoll rig** and the torque-shaped ones under **Skis** are **angular accelerations in rad/s²**, not torques. The code multiplies them through the relevant inertia at the point of use. This matters when reading a slider: `muscleStiffness` 900 means "close this joint at 900 rad/s² per radian of error", and it means the same thing on a 16 kg torso and a 1.8 kg forearm. Stability is then governed only by `stiffness × step²` and `damping × step`, both of which stay small at the default 1/120 s step.

### Export — non-negotiable

A **COPY CONFIG** button that serializes the current `CONFIG` to a plain text block and puts it on the clipboard. Without export, every tuning session is thrown away on refresh.

The exported block is pasteable directly into a voice session or a Claude Code prompt, and the instruction back to Claude Code is always the same: *replace the `CONFIG` block with this one.* No interpretation required.

### Reset

A **RESET TO COMMITTED** button restoring the values as they exist in the source file. Needed because tuning by thumb goes wrong often.

---

## 7. Bug Capture Format

Bugs are found while playing, one-handed, mid-session, by voice. The format has to survive that.

**Spoken during a live session, four fields, in this order:**

1. **What happened** — the observable thing.
2. **What was expected** — omit if obvious.
3. **Repro** — what was being done at the time. "Every landing" or "only after a backflip" is enough.
4. **Severity** — one of `blocker`, `feel`, `polish`.

Severity drives the loop. `blocker` means the next spec handoff leads with it. `feel` means it's a tuning candidate and probably belongs on the debug panel rather than in a code change. `polish` accumulates and ships in batches.

At the end of a play session, the captured list is folded into `SKI_STUNT_3D_GAME_SPEC.md` as a **Fix list** section, ordered by severity. That section is the first thing Claude Code reads.

### Reading state off the phone

The page keeps a live probe at `window.__ski`: `booted`, `frames`, `gl`, plus live references to `run` (state, distance, air time, flips) and `config`. In Chrome on Android, `chrome://inspect` is not usable one-handed, but the probe is what the smoke test reads, and it is the first thing to check if the page comes up blank.

If the module never runs at all — CDN unreachable, bad pin, syntax error — a watchdog paints the reason over the page after 8 seconds instead of leaving a white rectangle. That message is designed to be read on a phone with no devtools.

---

## 8. Headless Smoke Test

```
node tools/smoke-test.mjs               # everything
node tools/smoke-test.mjs --no-boot     # skip the browser check
node tools/smoke-test.mjs --base main   # diff against a specific ref
```

No dependencies, no install step. Node 22+.

**Mandatory before every push. If any check fails, fix and re-run; do not push a red build.**

1. **Parse check** — every `<script>` block is written out and run through `node --check`; the import map is parsed as JSON.
2. **Import resolution** — every CDN URL in the import map is fetched and must return 200. Pinned versions only, never `latest` or a range. When the sandbox blocks the CDN (a 403 from the egress proxy is the normal case in Claude Code's cloud environment), the check falls back to the npm registry — which is where jsDelivr serves those exact bytes from — and confirms both that the version exists and that the file path is present inside the published package. It reports `warn` rather than `pass` when it had to do that, so the difference is never hidden. A real 404 from the CDN still fails.
3. **Symbol check** — no references to names that are never bound anywhere, and every `THREE.x` / `CANNON.x` member is checked against the real export list of the pinned build. That second half catches the class of typo that produces a blank page and nothing else.
4. **CONFIG integrity** — every key the debug panel references exists in `CONFIG`; every `CONFIG` key is actually read as `CONFIG.<path>` somewhere in the game; every committed value sits inside its own slider's range. Catches drift in every direction.
5. **Structural check** — exactly one canvas element, the entry point is invoked, the debug panel is gated behind `?debug=1` and exists nowhere in static markup, and the liveness probe is present.
6. **Diff sanity** — lists what the commit touches and flags anything outside `index.html`, the two docs, `tools/` and `.github/`.
7. **Boot check** — vendors the pinned modules locally, serves the page, and opens it in headless Chromium over the DevTools protocol. Asserts the page boots, acquires a WebGL context, keeps rendering, reports no console errors, and that `?debug=1` builds the panel while a plain load does not. Skips cleanly, with a note, where no Chromium is available.

The PR description states which checks ran and their result — the smoke test prints a markdown table for exactly that. That is the only build signal available on a phone, so it matters.

### What this deliberately does not cover

Rendering, visual correctness, and feel. The boot check proves pixels are being produced; it says nothing about whether they look right. Physics stability is *partly* covered — the simulation can be driven headlessly and its numbers read back, which is how the first playable slice was debugged — but "does this feel good to ski" is not machine-checkable and is verified by playing.

---

## 9. Batching

Never push a one-line tweak. Each Pages rebuild costs 30 seconds to 2 minutes, and that cost is per merge, not per change. Three or four changes merged together cost one rebuild instead of four.

Practical rule: a voice session produces one spec, one Claude Code run, one merge, one rebuild, one play session. If something small comes up mid-session, it goes on the fix list rather than triggering its own loop.

**Optional escape hatch:** Android editors like Acode or Spck Editor serve the single file locally with instant preview. No Claude integration, so code must be pasted by hand — useful for a pure tuning pass when the debug panel isn't enough, not for authoring.

---

## 10. Two-Document System

Deliberately split, because they change at different speeds.

| Doc | Contents | Churn |
|---|---|---|
| **`SKI_STUNT_3D_PIPELINE.md`** (this) | Repo, Pages, build architecture, deploy loop, debug panel contract, smoke test, tooling | Written once, rarely touched |
| **`SKI_STUNT_3D_GAME_SPEC.md`** | Mechanics, ragdoll rig, animation states, level generation, fix list, scope | Rewritten most sessions |

Both live in the repo. Claude Code reads the pipeline doc for how to work and the game spec for what to build. Committing them means the design has version history, and means a session starts by pointing at a file rather than pasting one.

---

## 11. Open Questions

1. ~~Direct to `main`, or branch per change?~~ **Resolved: branch and PR while the shape is still being found.** Move to direct pushes on `main` once the smoke test has proven itself over a few weeks.
2. ~~Paste the spec, or commit it?~~ **Resolved: commit it.** Version history for the design, and Claude Code always reads current truth rather than whatever got pasted.
3. ~~Is a GitHub Actions workflow ever needed?~~ **Resolved for now: no.** Branch-deploy covers the whole deploy path, and the smoke test runs in the Claude Code session before the push, which is where a red result is cheapest to act on. Revisit only if a push ever lands unchecked — running the same script in CI is four lines of YAML and needs no dependencies.
4. Voice session persistence — Android suspends the mic on screen lock, and no permission overrides that if the app lacks a foreground audio service. Battery set to Unrestricted and "stay awake while charging" help but don't fully solve it. Currently unresolved.
5. Live play sessions put the game and the voice session on the same phone, competing for foreground. Needs testing: whether a voice session survives being backgrounded while Chrome is in front, and if not, whether split-screen is workable.
6. Does the debug panel need value persistence across page refreshes, or is Copy config enough? Start without it; add only if refresh-loss becomes annoying in practice.
7. New: is 63 sliders already too many for a thumb? The sections collapse and only Physics starts open, which helps, but a "favourites" row of the six values actually being hunted may be worth it.

---

## 12. Summary

The "Jarvis" workflow is real, with one seam in it: the manual paste from voice session to Claude Code. Everything else is automated and phone-native.

Talk the design through by voice, commit the spec, let Claude Code build and smoke-test and push, merge and play from the phone, capture bugs by voice while playing, repeat.

Three things make it work. The **debug panel** removes deploy latency from the tuning loop, which is where latency actually hurts. The **smoke test** means a push that reaches the phone will at least load — and, where a headless browser is available, that it boots and renders. The **single-file architecture** keeps the whole thing phone-shaped.
