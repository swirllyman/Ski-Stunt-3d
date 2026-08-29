# Ski Stunt 3D

A ragdoll ski stunt game in one HTML file. No build step, no npm, no bundler.

**Play:** https://swirllyman.github.io/Ski-Stunt-3d/
**Tune:** https://swirllyman.github.io/Ski-Stunt-3d/?debug=1

## Layout

| Path | What |
|---|---|
| `index.html` | The whole game. Three.js + cannon-es from a pinned CDN import map. |
| `SKI_STUNT_3D_PIPELINE.md` | How this project is built and shipped, from a phone. Read first. |
| `SKI_STUNT_3D_GAME_SPEC.md` | What the game is, and the current fix list. Read second. |
| `tools/smoke-test.mjs` | Headless pre-push check. No dependencies. |
| `tools/live-check.mjs` | Post-deploy check: drives the real Pages URL in a real browser. |
| `.github/workflows/ci.yml` | Runs both on GitHub, so the result is readable from the phone. |

## Before pushing

```
node tools/smoke-test.mjs
```

Node 22+. Green or don't push — see section 8 of the pipeline doc for what each
check covers and why. The script prints a markdown table for the PR description.

## After a deploy

```
node tools/live-check.mjs https://swirllyman.github.io/Ski-Stunt-3d/
```

Waits until Pages is serving the committed `index.html`, then opens it in
headless Chromium and checks it boots, holds a WebGL context and keeps
rendering. CI does this automatically on every push to the default branch.

## Controls

Three pads along the bottom. Carve left, tuck (release to pop), carve right.
In the air the carve pads become backflip and frontflip. `R` resets.
On a keyboard: `A`/`D` carve, `S` tuck, `Space` pop, `R` reset.
