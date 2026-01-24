# Weekly Planning Mode

Review the previous week and generate the next using auto-progression logic.

## Trigger Patterns

- "What's the plan for this week?"
- "Let's review last week"
- "Generate next week"
- "How did last week go?"

---

## Conversation Flow

### Review Last Week

1. Pull completed sessions from `workouts` and `workout_sets`
2. Show summary: sessions completed, avg readiness, any flags
3. Per exercise: target vs actual, pump, joint issues
4. Highlight anything that needs attention

### Generate Next Week

1. Run auto-progression logic for each exercise
2. Show proposed changes in a table (exercise, last week, result, next week, change)
3. Flag any exercises needing manual decision (joint issues, conflicting signals)
4. Ask user to resolve flags
5. Allow overrides
6. Confirm before saving to `weekly_targets`

---

## Data Read

| Table | Fields | Purpose |
|-------|--------|---------|
| `weekly_targets` | exercise_id, target_sets, target_reps, target_weight_kg, week_number | Previous targets |
| `workout_sets` | exercise_id, weight_kg, reps, rpe | Actual performance |
| `workout_exercise_notes` | pump_quality, joint_discomfort | Feedback |
| `workouts` | sleep_quality, energy_level, muscle_soreness, rating | Session readiness |
| `exercises` | name, equipment | Exercise info + increment size |
| `mesocycles` | rpe_start, rpe_end, weeks | RPE progression plan |
| `active_mesocycle` | name, week_number, end_date | Block context |

---

## Data Write

| Table | Fields | When |
|-------|--------|------|
| `weekly_targets` | exercise_id, target_sets, target_reps, target_weight_kg, week_number, mesocycle_id, mesocycle_day_id | After user confirms |

---

## Auto-Progression Logic

### Inputs per Exercise

- Target: sets × reps @ weight @ RPE (from `weekly_targets`)
- Actual: sets × reps @ weight @ RPE (from `workout_sets`)
- Pump quality 1-5 (from `workout_exercise_notes`)
- Joint discomfort 0-3 (from `workout_exercise_notes`)
- Pre-session readiness: sleep, energy (from `workouts`)
- Equipment type (from `exercises`)

Note: `target_reps` is stored as text (e.g., "8-10"). Parse to extract bottom and top of range.

### Weight Progression

| Condition | Action |
|-----------|--------|
| Hit top of rep range on all sets | Bump weight |
| Hit bottom of rep range | Hold |
| Missed bottom, poor readiness (sleep ≤2 or energy ≤2) | Hold (retest) |
| Missed bottom, readiness fine, RPE < 9 | Hold (execution issue) |
| Missed bottom, readiness fine, RPE ≥ 9 | Drop weight |

### Equipment Increments

| Equipment | Increment |
|-----------|-----------|
| barbell | 2.5kg |
| smith | 2.5kg |
| dumbbell | 2kg (if ≤12kg, prefer volume instead) |
| cable | 2.5kg |
| machine | 2.5kg |
| bodyweight | Add reps first, then load |

### Volume Progression

Logic: High pump = muscle responding well = can handle more stimulus.

| Condition | Action |
|-----------|--------|
| Pump 4-5 AND pre-session soreness ≤2 AND hit all reps | Add set |
| Pump 1-2 OR pre-session soreness ≥4 | Drop set |
| Otherwise | Hold |

Note: "Soreness" here refers to `workouts.muscle_soreness` (pre-session, for the relevant muscle group).

### Safeguard

If adding volume → do NOT also bump weight. One variable at a time.

### RPE Progression

Follows mesocycle plan with linear interpolation:

```
target_rpe = rpe_start + (current_week / total_weeks) * (rpe_end - rpe_start)
```

Example: rpe_start=6, rpe_end=9, 4-week block → Week 1: 6.75, Week 2: 7.5, Week 3: 8.25, Week 4: 9

### Deload

Trigger: Every 4th week OR end of mesocycle OR user requests.

Deload prescription:
- 50% volume (half the sets)
- RPE 5-6
- Same weights (maintain neural patterns)

### Flags (Manual Decision Required)

- Joint discomfort > 0 on any set
- Conflicting signals (good performance + discomfort)
- Persistent joint issues (2+ weeks) → suggest exercise swap

### Auto-Handle (No Flag)

| Situation | Action |
|-----------|--------|
| Missed session | Carry forward unchanged |
| Stall (same reps 2 weeks in a row) | Add set |
| Partial completion (fewer sets than planned) | Carry forward, note in review |

Note: Stall detection requires comparing current week to previous week in `workout_sets`.

---

## Exercise Swaps

If joint discomfort persists 2+ weeks on same exercise:

1. Flag for review
2. Suggest alternatives from `exercises` with same `muscle_group` and `movement_pattern`
3. User picks replacement or keeps current
4. If swapped, carry over progression (relative intensity)

---

## Response Style

- Tables for summaries and proposed changes
- Show changes clearly before saving
- Always confirm before writing
- Connect dots: "Pump has been low on lateral raises for 3 weeks — consider swapping to cable version?"

---

## Example Interactions

**Example 1: Week review**
```
User: How did last week go?

Claude: Week 3 Summary

Sessions: 3/3 ✓
Avg readiness: Sleep 3.7, Energy 3.3

| Exercise | Target | Actual | Pump | Joint |
|----------|--------|--------|------|-------|
| DB Bench | 4×8 @32.5kg | 8,8,8,7 | 4 | 0 |
| Incline DB | 3×10 @27.5kg | 10,10,8 | 3 | 1 |
| Pull-ups | 3×6 @+10kg | 6,6,5 | 4 | 0 |

Flags:
- Incline DB: mild shoulder discomfort (2nd week in a row)

Ready to generate Week 4?
```

**Example 2: Generate next week**
```
User: Yes, generate it

Claude: Week 4 Proposed Changes

| Exercise | Last Week | Result | Next Week | Change |
|----------|-----------|--------|-----------|--------|
| DB Bench | 4×8 @32.5kg | Hit 8,8,8,7 | 4×8 @32.5kg | Hold (missed top on set 4) |
| Leg Press | 4×12 @140kg | Hit 12,12,12,12 | 4×12 @145kg | +5kg (hit top of range) |
| Pull-ups | 3×6 @+10kg | Hit 6,6,5 | 3×6 @+10kg | Hold |
| Lat Raise | 3×15 @10kg | Hit all, pump 5 | 4×15 @10kg | +1 set (high pump, low soreness) |

⚠️ Flag: Incline DB — shoulder discomfort 2 weeks. Swap to low incline or cable fly?

User: Let's try cable fly

Claude: Swapped Incline DB → Cable Fly
Starting at 3×12 @12.5kg (similar relative load)

Confirm Week 4?
```

**Example 3: Confirm and save**
```
User: Looks good, save it

Claude: ✓ Week 4 saved to weekly_targets.

4 exercises progressed, 1 swapped, 2 held.
```
