# Ski Stunt 3D — Game Design Spec

**Status:** Design of record. Supersedes the design sections of `SKI_STUNT_3D_HANDOFF.md` *and* the previous version of this file. Where any two conflict, this document wins.

**GitHub:** `swirllyman/Ski-Stunt-3d`
**Live URL:** `https://swirllyman.github.io/Ski-Stunt-3d/`  (verified live by CI)

---

## 0. Status of the current build

Phase 1 of this spec is built: the planar architecture, the rig, and the single control axis. Phases 2–4 are not.

| MVP item | State |
|---|---|
| Single HTML file, Three.js + Cannon-es from CDN | done |
| Ragdoll rig — 6 effective joints, limbs mirrored, loose head | done |
| Muscle-force posture control from up/down input | done |
| Physics-driven skiing on a fixed test slope | done |
| Debug panel with live sliders | done, 66 |
| Camera with damping and lead | done, side-on 3/4 |
| Takeoff detection + handover to air animation | not started |
| Air pose set with velocity-flavoured blending | not started |
| Landing angle evaluation | not started |
| Momentum with chaining and cap | placeholder — HUD shows peak speed |
| Procedural level generator (seed + difficulty) | not started |
| Full-course preview / level sequencing | not started |
| Rigged GLB with bones driven by physics | not started |
| GitHub Pages deploy | done (previous design still on `main`) |

### The plane lock

`linearFactor (0,1,1)` and `angularFactor (1,0,0)` per body. Cannon applies both to force integration *and* to the solver's velocity corrections, so the lock genuinely holds. Section 5 wants the lock to break in flight; it does not yet — releasing it without the landing-angle evaluation just loses the skier sideways, so it waits for Phase 2.

Joints are **point-to-point, not hinges**. In the plane, `angularFactor` already forbids every rotation but X, so a hinge's two rotational equations have nothing to do — and the solver's response to them is masked, so they never converge, burn every iteration, and starve the contact equations they share a solver with. That made the rig collapse where it stood and then detonate at 7 km/s when the muscles were stiffened. A pivot plus the plane lock *is* a hinge about X.

### The pump: pop works, sustained momentum is unproven

The control is a **continuous analog stroke**, not a held button. Touching down anchors the axis wherever the finger lands, so a stroke never jumps; from then on posture tracks the finger, and how fast you slide is how hard the skier extends.

Measured by scripting strokes of different durations from the same loaded crouch:

| stroke | peak ski clearance | air |
|---|---|---|
| 0.05 s | 0.06 m | — |
| **0.12 s** | **0.41 m** | **0.47 s** |
| 0.25 s | 0.13 m | — |
| 0.5 s | 0.13 m | — |
| 1.0 s | 0.13 m | — |

So pop is analog and controllable, with a clear optimum: a well-timed stroke jumps three times as high as a lazy shove. That is a real skill to learn, and it is the mechanic section 1 asks for.

`pump.maxRate` turns out to be the mechanism rather than a safety limit, which was not obvious. Raising it from 6 to 14 destroys the jump entirely — every stroke flattens to 0.13 m. Capping the rate is what shapes the extension into something the legs can push the ground with; uncapped, the muscles snap through the pose without doing work on the snow. Do not "optimise" it upward.

**Pumping chains.** Measured over 24 s with an autopilot driving the analog axis off terrain curvature:

| autopilot | peak speed | distance |
|---|---|---|
| no input | 15.9 m/s | 223 m |
| **pumping correctly** | **20.9 m/s** | **238 m** |
| pumping deliberately wrong | 18.9 m/s | 218 m |

Correct timing wins on both counts — +31% peak speed over doing nothing. The margin over *wrong* pumping is only 10%, so the skill is real but not yet sharp; widening it is a tuning job.

### The terrain has a slope budget, and breaking it stalls the run

This wasted a whole measurement cycle and is worth stating plainly. A sine of amplitude A and wavelength L reaches a slope of `2·pi·A/L`. Once roller + chop exceed `tan(slopeAngle)`, the piste contains genuinely **uphill** sections, and a skier with no propulsion stops dead in the first one.

The defaults did exactly that: `2·pi·1.4/26 + 2·pi·0.35/9 = 0.58` against a hill of `0.33`. Runs built to 8.7 m/s, hit an uphill roller at ~29 m, and decayed to nothing — which read as "the pump does not work" for an entire session, when the pump was fine and the hill was unskiable.

Keep the sum under roughly 0.8 of `tan(slopeAngle)` until the pump is strong enough to climb. When it is, breaking the budget deliberately is how you build sections that *require* pumping.

### What the tuning cost

Load-bearing is the recurring problem in this rig and it took several wrong turns:
- Muscles sized by reduced inertia are right for swinging a limb in free space and roughly 10x too weak to hold a bent leg under load. Stiffness ended at 20000 rad/s^2 with a 1/240 s step.
- At that stiffness a single hard contact can inject energy faster than damping removes it, so joint torque is capped (`ragdoll.maxJointTorque`).
- Muscles alone still cannot stand the rig up; the postural reflex from the previous design is back in planar form (`ragdoll.balanceStiffness`). Set it to 0 for a pure flop.
- The rig now spawns square to the *slope*. Spawning square to the world buried a ski end, and a buried tip jams rather than slides.
- The hill had to steepen from 0.16 to 0.32 rad before the skier would accelerate at all.

## 0.1 Fix list

Live bugs, ordered by severity, per section 7 of the pipeline doc. Anything the redesign deletes has been struck from the old list rather than carried forward.

### blocker

*(none — the build boots, renders and plays)*

### feel

1. **The torso hunches ~35° forward at speed** and stays there; the spine muscle loses to gravity. Survives the redesign — the spine is the primary pumping joint, so this needs solving either way. Candidate: `ragdoll.muscleStiffness`, noting that past ~1400 the arms destabilised.

### polish

2. No sound at all.
3. The camera does not react to landings or crashes — no shake, no drop-back.

### superseded by this redesign

Flip completion, kicker landing survival, sustained-carve stability, top speed, crash frequency and hard-respawn recovery were all on the previous fix list. Every one of them concerns a mechanic this document replaces, so they are dropped rather than carried.

---

## 1. Core Concept

A physics-driven ski stunt game in the lineage of **Ski Stunt Simulator (2001)**. Gameplay is fundamentally **2D** — the skier is locked to a single plane — but rendered in **3D** with a cinematic camera.

There is **no jump button**. The player pumps the skier's body posture to generate momentum and launch off terrain, the same way you pump a skateboard. Jumping is an emergent result of timing body extension against the terrain, not a discrete action.

The appeal is twofold:
1. **Difficult, high-fidelity physics control** on the ground.
2. **Cinematic, polished animation** in the air.

---

## 2. Control Scheme

- **Single control axis: up / down.**
- Down loads a crouch; up extends the body.
- Input drives *muscle forces toward a target posture*, not direct positioning — the body is a ragdoll being pulled toward a pose, so it has weight, overshoot, and lag.
- **Sideways input** is a secondary flourish used for spins/rotations in the air. Exact mapping to be found through playtesting.
- Timing extension against terrain curvature is the whole skill of the game.

---

## 3. Ragdoll Rig

Keep the joint count low and hand-tunable.

| Joint | Notes |
|---|---|
| Ankles | Mirrored — both legs treated as one |
| Knees | Mirrored |
| Hips | Mirrored |
| Spine | Primary pumping joint |
| Arms | Mirrored — both arms treated as one |
| Head | Deliberately loose — free personality, "bobble" effect, sells crashes |

**~5–6 effective joints total.** Limb mirroring is possible because gameplay is locked to a 2D plane.

Spring tuning is the hard problem: too stiff reads as robotic, too loose and the skier collapses. Budget real time for this.

---

## 4. Grounded vs. Airborne: The Hybrid Model

This is the key architectural decision.

### Grounded — pure physics
Ragdoll driven by muscle forces toward the player's target posture. No animation clips. The pose *is* the input, every frame.

### Airborne — keyframed animation
On takeoff, control hands over from ragdoll to authored poses. Air is where there are no contact forces to fight, so animation quality can be prioritized.

- Air pose is **velocity-flavoured**: a violent extension launches an explosive pose; a lazy launch reads relaxed. Same clip, different intensity.
- A generic jump pose serves as fallback.
- **The handover is the technical crux** — blending from a ragdoll in an arbitrary pose into a keyframed clip at takeoff, and back again at landing.

### Air pose set
Roughly 5–6 core poses is likely enough: tuck, layout, spread, tweak, plus a couple of recovery flails. During long airtime the eye tracks silhouette and rotation, not finger detail, so slow blending between two poses reads as one fluid motion.

**Spend the animation budget on landings, not on more air poses.** That's where players notice snapping.

---

## 5. Rotation and Landing

- The 2D plane lock **breaks during flight**, allowing genuine spins.
- Landing is judged on angular offset from the plane:

| Offset | Result |
|---|---|
| 0–30° | Clean landing — momentum preserved / built |
| 30–60° | Stumble — momentum bled off |
| 60°+ | Wipeout |

This makes spins genuinely risky rather than free decoration, and defines the skill ceiling.

---

## 6. Momentum

Momentum is the scoring substrate.

- Clean landings **compound** momentum; stumbles bleed it.
- A good run is a **chain**, not one big trick.
- Self-balancing: faster speed → bigger air → harder landing angle to nail. Risk scales with reward automatically.
- Momentum **caps** eventually, to avoid the run degenerating into a physics blooper reel.
- Momentum chains **within a level**, not across a session.

---

## 7. Level Structure

**Revised from the original handoff doc** — this is *not* one infinite slope.

- The game is a sequence of **short, bite-sized levels**, each built around a **single stunt to accomplish**.
- Each level is **procedurally generated** from a **seed + difficulty index**, so it knows where it sits in the sequence.
- Level 1 is trivial; level 100 is brutal. One generator, one difficulty dial — no hand-authored level files.
- Difficulty is keyed to **level index / distance through the sequence**, not to live player performance.
- Difficulty clamps the generator's ranges: shallow angles, gentle lips, and wide flat landings early; opened up progressively.
- **The whole course is visible before the player starts.** Levels are small and readable, so it's a puzzle you solve with your hands rather than a reaction test.
- Fast restarts, clear failure states, retry-heavy loop.

### Onboarding
The punishing physics stay intact. Difficulty is managed by **curating what the player meets first** — the first level's lip should be so forgiving it's nearly impossible to miss.

---

## 8. Camera

- Follows from a 3/4 or isometric-ish angle, free to be cinematic since gameplay is planar.
- Smooth damping, never snappy.
- Leads slightly in the direction of the jump.
- Keeps the skier readable in frame at all times.

---

## 9. Technical Approach

**Revised from the original handoff doc.**

| Component | Choice | Reason |
|---|---|---|
| Build | **Single self-contained HTML file** | No build step, no Vite, no toolchain |
| 3D | Three.js via CDN | Drop-in, no install |
| Physics | Cannon-es via CDN | Ragdoll bodies + joints |
| Deploy | GitHub Pages | One file to commit, instant serve |

### Character model
- **Mixamo is not required and is a hands-on blocker** (login, manual download, no public API).
- Use a **no-signup rigged GLB from a public CDN** instead — e.g. Polyfork or Gobkit host rigged, animated GLBs loadable by URL with zero manual steps.
- Three.js does not rig anything itself; it plays what's in the file. For a ragdoll this barely matters: build the physics bodies + joints, then **drive the visual skeleton's bones from the physics bodies**. Model quality is close to irrelevant at that stage.

### Debug panel (important)
Build in an in-browser panel with live sliders for gravity, muscle spring stiffness/damping, jump feel, and blend times. Tuning this game takes dozens of passes, and a redeploy cycle per pass is dead time. Find the numbers live, then commit once.

---

## 10. Open Questions

1. Exact sideways-input mapping for spins — needs playtesting.
2. Spring stiffness/damping values for each joint — needs the debug panel.
3. How the difficulty dial maps to specific generator ranges (angle, lip height, landing width).
4. Whether airtime targets from the original doc (3–8s) still hold given the smaller level scale — likely shorter.
5. Sound: music + SFX from day 1 or later.
6. Scoring presentation: momentum as a visible number, or purely felt?
7. High scores: localStorage or nothing for MVP.

---

## 11. MVP Checklist

- [x] Single HTML file scaffold, Three.js + Cannon-es from CDN
- [ ] Ragdoll rig (5–6 joints, limbs mirrored, loose head)
- [ ] Muscle-force posture control from up/down input
- [ ] Physics-driven skiing on a fixed test slope
- [x] Debug panel with live physics sliders
- [ ] Takeoff detection + handover to air animation
- [ ] Air pose set (5–6 poses) with velocity-flavoured blending
- [ ] Landing angle evaluation (clean / stumble / wipeout)
- [ ] Momentum system with chaining and cap
- [ ] Procedural level generator (seed + difficulty index)
- [ ] Full-course preview before start
- [ ] Level sequencing + restart flow
- [x] Camera with damping and lead
- [ ] Rigged GLB loaded from public CDN, bones driven by physics bodies
- [x] GitHub Pages deploy
