# Ski Stunt 3D — Game Spec

Read this second. `SKI_STUNT_3D_PIPELINE.md` says how to work; this says what to build.

**Where it is:** first playable slice. A ragdoll skier rides a procedural piste, carves, tucks, pops, jumps the kickers and crashes. Everything below the "Fix list" is what to do next.

---

## Fix list

Ordered by severity, as section 7 of the pipeline doc requires. This is the first thing to read.

### blocker

*(none — the build boots, renders and plays)*

### feel

1. **Crashes are more frequent than they were** — 3 per 25 s of headless riding against 1 before the knee rework. The old build "survived" by crawling in the splits at 2–4 m/s; the new one rides at 9 m/s and falls over more. Mean speed is up 60%, so this is probably the better trade, but it wants a human verdict. Candidates: `ragdoll.leanTorque`, `ragdoll.balanceDamping`, `ragdoll.stanceStiffness`.
2. **No flip has ever completed.** Air time off a default kicker is ~0.3 s, and `ragdoll.airSpinTorque` cannot turn 2π in that. Either the takeoff needs to be steeper (`terrain.rampHeight` / `terrain.rampLength`), gravity needs to drop, or the pop needs to be bigger. Tried `physics.gravity: -18` headlessly and it made the *ride* markedly worse (runs dropped from ~70 m to ~25 m) before it helped the air, so this is a kicker-geometry problem first. Panel candidates: `terrain.rampHeight`, `terrain.rampLength`, `ski.popImpulse`, `ragdoll.airSpinTorque`.
3. **Landings off the kicker usually end in a crash.** The rider lands at ~15 m/s and the balance controller does not re-catch it. Candidates: `animation.landingBlend`, `animation.crashImpact`, `ragdoll.leanTorque`, `ragdoll.balanceDamping`.
4. **Holding full carve tips the rider over after ~25 m.** Better than it was (it used to be 5 m), and arguably correct for holding full lock indefinitely, but it should probably survive a sustained turn. Candidates: `ski.edgeSteer`, `ski.gripLimit`, `ski.bankAngle`.
5. **The torso hunches ~35° forward at speed** and stays there. The spine muscle is losing to gravity. It reads as a tuck rather than a fault, so it is low priority, but it is not intentional. Candidate: `ragdoll.muscleStiffness` — note that pushing it past ~1400 destabilised the arms in testing.
6. **Top speed is ~54 km/h and takes 4 s to reach.** Fine, possibly slow for a stunt game. Candidates: `terrain.slopeAngle`, `ski.glideDrag`, `physics.airDrag`.

### polish

7. No sound at all.
8. Score is distance, air time and a flip counter. No trick naming, no combo, no run summary on crash.
9. The camera does not react to landings or to crashing — no shake, no drop-back.
10. Trees are untextured cones and the snow is flat-shaded vertex colour. Reads fine at speed, thin when stationary.
11. Crash recovery is a hard respawn at the top. A restart-from-here would keep a long run alive.

---

## Controls

Three touch pads across the bottom, thumb-sized, plus a RESET button top-right.

| Pad | On the snow | In the air |
|---|---|---|
| **CARVE L** | turn left, banking into the turn | rotate backwards (backflip) |
| **TUCK · RELEASE TO POP** | crouch: less drag, more speed. Releasing it pops a jump | grab (tuck the rig up) |
| **CARVE R** | turn right | rotate forwards (frontflip) |

Keyboard, for desktop poking only: `A`/`←` and `D`/`→` carve, `S`/`↓`/`Space` tuck, `R` reset.

The two carve pads doing double duty is deliberate — three pads is the most a thumb can find without looking, and on/off the snow is never ambiguous.

---

## The skier

An eleven-body ragdoll: pelvis, torso, head, two upper arms, two forearms, two thighs, two shins. Skis are compound box shapes bolted to the shins, so each leg is one rigid boot-and-ski unit; the "ankle" is a torque that flattens the ski against the surface rather than a joint.

Joints are `ConeTwistConstraint`s, limited by `ragdoll.jointLimit` (a multiplier on per-joint cone angles) and `ragdoll.twistLimit` — **except the knees, which are hinges.**

That exception matters more than it sounds. A cone cannot tell flexion from splay: the 82° aperture the `grab` pose needs in order to *bend* the knee was also 82° of sideways travel, and the rig used all of it. Measured while riding, the knees averaged 37° of splay and pinned at ±66° after the first hard landing, leaving the skis 0.9 m apart against a 0.28 m stance — the splits, permanently, at a fifth of the speed. A real knee has essentially no abduction, so it is a `HingeConstraint` about the flexion axis. Average splay while riding: 37° → 4°.

Stance width then gets its own controller, because the hip is still a cone with the same blind spot. **Adductors** hold each thigh `ragdoll.stanceWidth` radians off the pelvis centreline with `stanceStiffness` and `stanceDamping`, equal and opposite on the pelvis so it is muscle and not a hand from the sky. Those three are the sliders to reach for if the legs feel too rigid or too loose.

### Spawn

Forward kinematics from the joint pivots: the pelvis is placed, then each child is put where its pivot meets its parent's, rotated by the `ready` pose, and the whole rig is dropped until the lower ski just clears the snow. The rig therefore spawns in exactly the pose the muscles are asking for, and the PD controller starts at zero error.

### Muscles

One PD controller per joint, on the child's orientation relative to the parent, driven by the blended pose target. Gains are angular accelerations; torque is `reduced inertia × α` about the torque axis, so the gain controls how fast the *joint angle* closes rather than how fast whichever limb is lighter gets thrown. The reaction is applied to the parent, so the rig cannot torque itself through space.

### Balance

Rider intent — staying upright, banking, flipping, steering — is applied as an angular acceleration of the rig about its own centre of mass: each body gets `α × d` of linear acceleration plus `I × α` of spin. Net force is zero, net torque is `I_com × α`, and the joints feel no stress. Torque alone cannot do this job; the `m·r²` term is most of the rig's inertia and needs force.

Every body takes part, legs included. The skis were held out of it while the knee was a cone and the leg could fold sideways underneath the rotation; with a hinge knee the leg turns as one piece, and measuring both ways is unambiguous — including the legs is worth 54 m against 22 m, half the crashes and 3 m/s more speed.

On the snow the target is the surface normal, banked by `atan(v · yawRate / g)` — the angle at which gravity and the centripetal reaction line up through the skis — clamped to `ski.bankAngle`. The bank follows the turn the skier is actually making, not the pad that was just pressed.

### Poses

`ready`, `tuck`, `air`, `grab`, `land`, `crash`. Each is a set of Euler triples per joint, written for the right-hand side and mirrored to the left. The active pose slerps toward its target over `animation.blendDuration` (or `animation.landingBlend` on landing). `crash` also drops muscle stiffness to `ragdoll.limpStiffness`.

State selection: crashed → `crash`; airborne longer than `animation.airborneDelay` → `grab` if tucking else `air`; grounded longer than `animation.groundedDelay` → `land` briefly after a real jump, else `tuck` or `ready`.

---

## Ski physics

Contact is analytic, not solver-driven: the terrain is a pure height function, so the ski's clearance and the surface normal are evaluated directly. Cheap, and it never misses a frame.

The ski shape carries its own `ContactMaterial` at zero friction, and snow resistance is modelled instead as:

- **lateral grip** — a delta-v applied to the whole rig that removes sideways velocity, capped by `ski.gripLimit` so an edge can let go and skid rather than erasing the rider's speed in a tenth of a second;
- **glide drag** — the same, along the ski, scaled by `ski.tuckDragScale` while tucking;
- **ankle align** — a per-ski torque flattening the ski to the surface normal;
- **edge steer** — a yaw of the rig about the surface normal, with authority that comes up with speed.

Everything else the rider hits (torso, arms, head) uses the body material at `physics.groundFriction`, so a crash scrubs.

---

## Terrain

One analytic height function drives both the collision heightfield and the render mesh, so what you see is what you hit.

- A constant descent at `terrain.slopeAngle`.
- Rolling bumps, faded in over the first 30 m so the start is clean.
- Kickers every `terrain.rampSpacing` metres: a `u²` rise over `terrain.rampLength` to `terrain.rampHeight`, then a lip and a drop. `terrain.rampWidth` keeps them wide and soft-edged; a narrow kicker with a steep flank catches the outside ski and ends the run before the jump starts.
- Side walls beyond `terrain.width`, rising quadratically.
- Conifers scattered outside the piste for speed perception.

Everything is seeded from `terrain.seed`, so a given seed is the same hill every time.

---

## Run state and scoring

- **distance** — furthest point down the fall line this run.
- **air** — cumulative time off the snow.
- **flips** — signed rotation about the rider's lateral axis while airborne, counted per 2π, announced with a toast.
- **best** — furthest distance this session.

A run ends when the head or torso ploughs the snow, when a landing exceeds `animation.crashImpact`, when the rider is toppled (`animation.uprightMin`) for `animation.fallenDelay`, or when they stall below `animation.stallSpeed`. That last pair is not cosmetic: without it, a rider face down in the snow with both skis in the air sits there forever, because "grounded" is false.

---

## Scope: what is deliberately not here yet

- No sound.
- No menus, no run summary, no persistence.
- No trick vocabulary beyond flip counting — no spins, no grabs scored, no rails.
- No alternative lines, gates, or objectives. One hill, one seed, ski to the bottom.
- Shadows are a single directional light tracking the rider; no ambient occlusion, no snow spray, no particles.

The next real feature should be decided by playing, not from this list.
