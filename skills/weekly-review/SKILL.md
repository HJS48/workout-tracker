---
name: weekly-review
description: Weekly training review and single workout review. Covers performance vs targets, health trends, run summary, auto-progression, and next week planning. Use when user asks to review their week, review a workout, generate next week, or says "weekly review", "how'd that go", "review last week".
---

# Weekly Review

Full weekly review cycle: performance analysis, health correlation, run summary, auto-progression, run planning, and target generation. Always present proposed changes for approval before saving.

## Weekly Review Flow

### 1. Gather data

Call in parallel:
- `get_active_mesocycle` — mesocycle context, training days (use the days array to know how many sessions were planned), start date
- `get_week_summary` with mesocycle_id and week_number — all workouts, sets, feedback, targets, readiness data
- `get_health_trends` — calculate date range from mesocycle start_date + week_number (e.g. week 1 starting March 2 = date_from 2026-03-02, date_to 2026-03-08)
- `get_run_sessions` filtered to the same date range — all runs for the week

### 2. Session overview

```
Week 1 — 2/3 gym sessions | 3 runs
Avg readiness: Sleep 3.7 | Energy 3.3
Avg rating: 4.0
```

Count planned sessions from mesocycle days array. Flag any missed gym sessions. Show run count separately.

### 3. Performance vs targets

Per-exercise table for each training day:

```
Pull Day (Mon) — Sleep 4 | Energy 3 | Back soreness 2
Exercise          | Target          | Actual           | Pump | Joint | Notes
Pull Up           | 3x8-10 @ BW+10 | 8, 8, 7 @ BW+10 | 4    | 0     |
Seated Row        | 3x10-12 @ 70   | 12, 11, 10 @ 70  | 4    | 0     |
```

Show the session's readiness data in the header — this is critical context for interpreting performance.

Highlight:
- Exceeded target range on all sets
- Hit target
- Missed significantly (not 1 rep off — that's noise)
- Joint discomfort > 0 (flag prominently)
- Pump 1-2 (flag — exercise may not be working)

### 4. Health trend analysis

Summarize the week's health data from `get_health_trends`:

```
Health: BB avg 52 (range 35-72) | RHR avg 48 (7d avg 49) | Sleep avg 7h10m | Stress avg 18
```

Flag concerning patterns:
- BB trending down across the week
- RHR elevated vs 7-day average (the `seven_day_avg_rhr` field)
- Sleep consistently under 7h
- High stress days correlating with bad sessions

### 5. Performance-health correlation

Connect health data to training outcomes using the per-workout readiness (sleep_quality, energy_level, muscle_soreness stored on each workout):

- Bad session + low BB/high stress/low energy = expected, no programming concern
- Bad session + good BB/low stress/high energy = potential programming issue
- Good session + low BB = user performs well despite poor recovery (note it)
- RHR rising across the week = accumulating fatigue

For muscle_soreness, check the specific muscle groups against exercise performance. E.g. if `muscle_soreness.back` was 3 and Pull Up reps were down, that's expected — not a programming issue.

### 6. Run summary

```
Runs: 3 this week | 15.2km total | avg pace 5:24/km
- Mon: Easy 5.1km @ 5:42/km (HR avg 142) — Energy 4
- Wed: Tempo 5.0km @ 4:58/km (HR avg 162) — Energy 3
- Fri: Easy 5.1km @ 5:31/km (HR avg 139) — Energy 4
```

Include pre-run readiness (sleep_quality, energy_level) if logged. Correlate: slow run + low energy = expected. Slow run + high energy = worth noting.

Note trends vs previous weeks if data exists. Flag if weekly mileage jumped >10%.

### 7. Generate next week — Auto-Progression

For each exercise, apply this sequence:

**Step 1: Check flags**
- Joint discomfort > 0? Do not progress. Consider swap if flagged 2+ weeks.
- Pump 1-2 for 2+ weeks? Do not add volume. Fix exercise first.
- Missed session? Carry forward unchanged.

**Step 2: Set progression**

Use the specific muscle group soreness from pre-session data, not an overall number. E.g. for Pull Ups, check `muscle_soreness.back` and `muscle_soreness.biceps`.

| Pump | Soreness (relevant muscle groups) | Action |
|------|------|--------|
| 1-2 | 0-2 | +1 set |
| 3-4 | 2-3 | Hold |
| 4-5 | 4-5 | -1 set |

Additional rules:
- Spread set increases across days — don't add sets to every exercise on one day.
- Don't add sets if significantly missing reps.
- New exercises hold sets for 1 week.
- If adding a set, hold reps and weight.

**Step 3: Rep progression**

| Condition | Action |
|-----------|--------|
| Hit reps at target RPE | +1 rep/set next week |
| Missed reps, pump high (4-5) | Hold (exercise is working) |
| Missed reps, pump low, RPE high | Drop weight, rebuild reps |

RPE target calculation: `rpe_start + (current_week / total_weeks) * (rpe_end - rpe_start)`

**Step 4: Weight progression** (only if exceeded rep range on ALL sets)

| Equipment | Increment |
|-----------|-----------|
| Barbell / Smith | 2.5kg |
| Dumbbell | 2kg |
| Cable / Machine | 2.5kg |
| Bodyweight | Add reps first, then load |

Bump weight, reset reps to bottom of range.

**Priority when multiple changes possible (only change one lever at a time):**
1. Adding a set → hold reps, hold weight
2. Increasing reps → hold weight, hold sets
3. Increasing weight → reset reps to bottom of range, hold sets

**Isolation exercise exception:** Pump matters more than reps. If pump is 4-5 but reps are low, the exercise is working. Hold.

**Myo-rep / Giant set exception:** Progress by +5 total reps per week (not per set). If missed, hold.

**Stall detection:** Same reps for 2 weeks at same weight = stall. Flag it. Consider adding a set.

### 8. Deload check

Check health trends and compare RHR to `seven_day_avg_rhr` from previous weeks if available.

Trigger deload when ANY of these occur:
- Body Battery morning < 30 for 3+ days in the week
- RHR elevated 5+ bpm above 7-day average for 3+ days
- Stress avg > 40 for 3+ days
- End of mesocycle
- User requests

Also consider deload every 4th week as a fallback if trends are unclear.

Deload prescription: 50% volume (half the sets), RPE 5-6, same weights.

### 9. Plan next week's runs

The mesocycle is 3 gym + 3 run days per week. There is no structured run plan in the database — run planning is based on the 5K sub-23:00 goal, recent performance, and recovery state.

Suggest run types for the week:
- Default split: 2 easy + 1 quality session (tempo, interval, or fartlek)
- If deloading or high fatigue: all easy
- Reference recent paces from `get_run_sessions` for target ranges
- If BB trending low or energy ratings low: swap quality session for easy
- Don't prescribe exact paces — suggest ranges based on recent data

### 10. Present for approval

Show the full proposed plan:

```
Next Week (Week 2) — Proposed Changes

Pull Day:
Exercise          | Sets | Reps  | Weight | Change
Pull Up           | 3    | 9-11  | BW+10  | +1 rep (hit all targets)
Seated Row        | 3    | 10-12 | 72.5   | +2.5kg (exceeded range)

Runs:
- Tue: Easy ~5km
- Thu: Tempo ~5km (target ~5:00/km based on recent 4:58 avg)
- Sat: Easy ~5km
```

Flag any exercises needing manual decision (swap candidate, unclear progression, stall).

**Do not save until the user confirms.** Present, discuss, adjust if needed, then call `save_weekly_targets` once approved.

## Single Workout Review

When the user asks to review a specific completed workout (not the whole week):

1. Call `get_workout_review` — returns workout metadata (including readiness), all sets, exercise feedback
2. Call `get_workout_plan` for the planned targets
3. Show readiness context at the top (sleep_quality, energy_level, muscle_soreness, BB)
4. Compare actual vs planned in a table
5. Highlight: exceeded targets, hit targets, significant misses
6. Flag: joint discomfort > 0, pump 1-2, significant rep misses
7. Correlate misses with readiness — low energy + missed reps = expected

When discussing adjustments:
- Present options, let the user decide
- Once agreed, update via `save_weekly_targets`
