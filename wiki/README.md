# Agent knowledge base (WikiSkill)

A persistent, compounding knowledge base for agents working in this repo, adapted
from **WikiSkill** (Tang et al., Google Research, arXiv:2608.27454). The paper
co-evolves agent *skills* with a *persistent wiki* so hard-won lessons stop
scattering across one-off sessions and instead accumulate.

## The three layers

| Layer | WikiSkill | Here | Rule |
|-------|-----------|------|------|
| **Raw** | immutable execution traces | your Claude Code / agent transcript | write-once, don't re-store it |
| **Wiki** | `patterns/`, `index.md`, `logs.md` | this directory | **compounds, never reset** |
| **Skill** | `skills/SKILL.md` | `CLAUDE.md` / `AGENTS.md` | polished, always-loaded, editable |

The Wiki is the middle layer the paper adds: a place for *why* things broke and
what worked, kept separate from the polished always-on instructions so those stay
short (progressive disclosure). It is never wiped, even when a skill edit is
reverted.

## The loop future agents run

1. **Read** — at the start of non-trivial work, read `index.md` and open any
   pattern whose description matches the task. This is you loading experience.
2. **Do the task** — your transcript is the Raw layer; nothing to write yet.
3. **Consolidate (Wiki Maintainer)** — after finishing, if you hit a failure,
   dead end, or found a strategy worth reusing: root-cause it and record it as a
   pattern (below). Add/update its line in `index.md`. Append one dated line to
   `logs.md`. **Do this even if the task itself failed** — the lesson persists.
4. **Promote (Skill Proposer + gate)** — when a pattern has proven useful across
   more than one session, promote its actionable core into `CLAUDE.md` (the Skill
   layer). The gate is *repeated usefulness*, not a benchmark. The pattern stays
   in the wiki as the audit trail. Never delete wiki history to make room.

## Writing a pattern

One file per failure-mode or reusable strategy: `patterns/NNNN-slug.md`, numbered
in order, numbers never reused (like the migration files). Template:

```markdown
# NNNN — Short title

**Type:** failure-mode | strategy
**Applies when:** one line so the index/reader can tell if it's relevant.

## Symptom
What you saw (the trap, the error, the wrong output).

## Root cause
Why it actually happens — not the surface.

## Workaround
The concrete fix / the thing that worked. Copy-pasteable if possible.

## Seen
- YYYY-MM-DD — one line of context.
```

Keep patterns short. If a pattern grows into a full procedure that every session
needs, that's the signal to promote it to `CLAUDE.md`.

## Boundary with the user's global memory

The user keeps a private, cross-project memory on their own machine. That is for
personal preferences and facts that span repos. This wiki is **committed and
repo-scoped**: durable lessons about *this codebase* that every future agent,
checkout, and teammate should get. When in doubt, repo-specific → here.

## What was deliberately skipped

The paper's automated outer-loop (benchmark rollouts, validation gating, N-run
averaging) is not built: there is no training set or benchmark in this repo, so
the harness would train nothing. The agent performs the Maintainer/Proposer steps
by hand via the loop above. Add the harness only if this repo ever grows an
automated agent eval to gate against.
