---
name: run-session
description: Guide a pre-run readiness check and intensity recommendation. Use when user says they're going for a run, heading out, or it's a run day.
---

# Run Session

Pre-run readiness assessment and intensity recommendation. Front-loaded then hands-off -- user runs, Garmin syncs automatically, post-run review is optional.

## Pre-Run Flow

### 1. Sync first, then load data

Call `sync_garmin_data` and `get_active_mesocycle` first (can be parallel -- neither depends on the other).

Then calculate week from the mesocycle: `week = ceil((today - mesocycle.start_date + 1) / 7)`

Then call `get_readiness` and `get_weekly_run_targets(mesocycle_id, week_number)` in parallel (both need mesocycle data first).

### 2. Display planned session

Match today's day-of-week against run targets. Format based on `run_type`:

**Intervals:**
```
Planned: Intervals -- [count]x[distance]m @ [interval_pace_text]
[warmup_text] | [recovery_text] | [cooldown_text]
HR target: [target_hr_text] | Cadence: [target_cadence_spm] spm
```

**Tempo:**
```
Planned: Tempo -- [duration_min] min @ [target_pace_text]
[warmup_text] | [cooldown_text] | HR target: [target_hr_text]
```

**Easy / Long:**
```
Planned: [Easy/Long] run -- [duration_min] min
[target_pace_text], [target_hr_text] | Cadence: [target_cadence_spm] spm
```

**Fartlek:**
```
Planned: Fartlek -- [duration_min] min total
[notes]
```

**Race (e.g., time trial):**
Display pacing strategy and pre-race protocol from the target's `notes` field.

If today isn't a scheduled run day, mention that but proceed if the user wants to run anyway.
If the target has notes (e.g., special instructions), display them.

### 3. Display readiness

```
Garmin: Sleep 7h25m | BB 59 (high 83, low 25) | Stress avg 10 | RHR 47
```

### 4. Ask subjective readiness

```
Sleep / Energy / Quads / Calves / Hamstrings / Glutes / Hip flexors soreness:
```

Sleep 1-5, Energy 1-5, Soreness 0-5 (0 = none). Accept numeric or verbal. Parse what you can.

### 5. Intensity recommendation

| Condition | Recommendation |
|-----------|---------------|
| BB >50, energy 4-5, soreness mostly 0-1 | Proceed as planned |
| BB 30-50 or energy 2-3 | Consider swapping hard session for easy |
| BB <30 or energy 1 | Suggest easy run or rest day |
| Any muscle soreness 4-5 | Flag it -- suggest easy or rest |
| Stress avg >50 | Mention it as a factor |

State the recommendation relative to what was planned. Don't insist -- the user decides.

### 6. Log readiness

Call `log_run_readiness` with:
- `date`, `sleep_quality`, `energy_level`
- `muscle_soreness` as structured JSONB
- `notes` if anything noteworthy

Confirm: `Logged. Have a good run.`

## Post-Run Flow

Triggers when user says "how was the run", "back from my run", "just finished".

### 1. Get run data

Call `get_run_sessions` with today's date. Also call `get_weekly_run_targets` for comparison.

### 2. Display summary

```
5.2km | 27:14 | 5:14/km avg
HR: avg 152, max 171 | Cadence: 148 spm (target: 150)
Fastest km: 4:48
```

Show what's available. Don't pad with "N/A" for missing fields. Compare cadence to target if available.

### 3. Classify and update

If `run_type` is null, ask:
```
Run type? (easy / tempo / interval / long / fartlek)
```

Call `update_run_session` with:
- `run_session_id`, `run_type`
- `notes`, `perceived_effort` if offered
- From the planned run target, pass: `target_cadence_spm`, `target_pace_s_per_km` (convert pace text to seconds if needed), `target_hr_min`, `target_hr_max` (parse from `target_hr_text` if structured as "HR 155-165")

### 4. Context from readiness

Only when meaningful:
- "Energy was 2 pre-run and pace was 15s/km slower -- tracks."
- "BB was 35 but you ran faster than usual -- nice."

## Response style

- Pre-run: 2-3 messages total. Post-run: 1 message unless discussing.
- No "Great run!" unless genuinely notable (PR, beat expectations).
