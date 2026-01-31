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

**1. Pull completed sessions**
- Query all workouts for the week
- Query all sets, exercise notes, and pre-session notes

**2. Show summary**
- Sessions completed vs planned (e.g., 3/4)
- Avg sleep, energy, soreness from pre-session notes
- Any session-level notes or flags

**3. Per exercise table**

| Exercise | Target | Actual | Pump | Joint | Notes |
|----------|--------|--------|------|-------|-------|
| Pull Up | 3×6-8 @ BW | 8, 8, 6 | 2 | 0 | — |

- Target: sets × reps @ weight from `weekly_targets`
- Actual: reps per set @ weight from `workout_sets`
- Pump: from `workout_exercise_notes.pump_quality`
- Joint: from `workout_exercise_notes.joint_discomfort`
- Notes: any exercise or set notes worth surfacing

**4. Highlight flags**
- Joint discomfort > 0
- Pump 1-2 (connection issues)
- Significant rep misses
- Exercises that were swapped mid-session
- Any notes mentioning pain, discomfort, or technique issues

### Generate Next Week

1. Run auto-progression logic for each exercise (see below)
2. Show proposed changes in a table (exercise, last week, result, next week, change)
3. Flag any exercises needing manual decision
4. Ask user to resolve flags
5. Allow overrides
6. Confirm before saving to `weekly_targets`

---

## Data Read

| Table | Purpose |
|-------|---------|
| `weekly_targets` | Previous week's targets |
| `workout_sets` | Actual performance (weight, reps, RPE) |
| `workout_exercise_notes` | Pump, joint discomfort |
| `workouts` | Session metadata, pre_session_notes (soreness) |
| `exercises` | Exercise info, equipment type |
| `mesocycles` | RPE progression plan (rpe_start, rpe_end) |
| `active_mesocycle` | Current block context |

## Data Write

| Table | Fields | When |
|-------|--------|------|
| `weekly_targets` | exercise_id, target_sets, target_reps, target_weight_kg, week_number, mesocycle_id, mesocycle_day_id | After user confirms |

---

## Auto-Progression Logic

### Core Principles

Progression has three levers: **weight**, **reps**, and **sets**. Only adjust one at a time.

- **Reps** — increase weekly via RPE (+1 rep/set at same weight)
- **Weight** — increases when exceeding top of rep range on ALL sets
- **Sets** — increase across the meso; pump + soreness confirm readiness

**Priority order when multiple changes are possible:**
1. If adding a set → hold reps (same as previous week), hold weight
2. If increasing reps → hold weight, hold sets
3. If increasing weight → reset reps to bottom of range, hold sets

---

### Weekly Review Flow

For each exercise, follow this sequence:

**Step 1: Check for flags**
- Joint discomfort > 0? → Flag, don't progress, consider swap if 2+ weeks
- Pump 1-2 for 2+ weeks? → Flag, don't add volume, fix exercise first
- Missed session? → Carry forward unchanged

**Step 2: Assess set progression**
- Get pump (from exercise feedback)
- Get soreness (from pre-session notes when that muscle was last trained)
- Apply set decision table (see below)
- If adding a set → stop here, hold reps

**Step 3: Assess rep progression**
- Compare actual reps to target
- Apply rep decision table (see below)
- If exceeded range on ALL sets → move to Step 4

**Step 4: Assess weight progression**
- Only if exceeded rep range on ALL sets
- Bump weight per equipment increments
- Reset rep targets to bottom of range

---

### Progression Rules

#### Sets

| Pump | Soreness (pre-session, that muscle) | Action |
|------|-------------------------------------|--------|
| 1-2 | 0-2 | +1 set |
| 3-4 | 2-3 | Hold |
| 4-5 | 4-5 | -1 set |

**Additional rules:**
- Spread increases across days (e.g., +2 chest = +1 Day 1, +1 Day 3)
- Don't add sets if significantly missing reps
- New exercises: hold sets for 1 week minimum
- No soreness data yet: hold, flag for review
- Stall (same reps 2 weeks): consider +1 set

#### Reps

| Condition | Action |
|-----------|--------|
| Hit reps at target RPE | +1 rep/set next week |
| Missed reps, pump high (4-5) | Hold — exercise is working |
| Missed reps, pump low, RPE high | Drop weight, rebuild reps |

**RPE target calculation:**
```
target_rpe = rpe_start + (current_week / total_weeks) * (rpe_end - rpe_start)
```
Example: rpe_start=6, rpe_end=9, 4-week block → Week 1: 6.75, Week 2: 7.5, Week 3: 8.25, Week 4: 9

#### Weight

| Condition | Action |
|-----------|--------|
| Exceeded range on ALL sets | Bump weight |
| Exceeded range on some sets | Hold, push for consistency |
| Within range / hit top | Hold, +1 rep/set |

**Equipment increments:**

| Equipment | Increment |
|-----------|-----------|
| Barbell / Smith | 2.5kg |
| Dumbbell | 2kg |
| Cable / Machine | 2.5kg |
| Bodyweight | Add reps first, then load |

---

### Feedback Interpretation

#### Pump (1-5)
- **1-2**: Not connecting with muscle. Don't add volume — fix exercise first (drop weight, adjust tempo, or swap)
- **3**: Adequate. Hold or progress normally
- **4-5**: Strong stimulus. Exercise is working — trust it even if reps are low

#### Soreness (1-5, pre-session notes from when that muscle was last trained)
- **0-2**: Recovering fast. Can handle more volume
- **2-3**: On track. Hold
- **4-5**: Not recovering. Consider dropping volume

#### RPE
- Trending toward 9-10 across exercises → approaching limit, prepare for deload
- Consistently below target → weight may be too light

#### Isolation exercises
Pump matters more than reps. If pump is 4-5 but reps are low, the exercise is working — hold and trust it.

#### Myo-rep / Giant set exercises
Progress by +5 total reps per week (not per set). If missed target, hold.

---

### Exception Handling

#### Flags (require manual decision)
- Joint discomfort > 0
- Conflicting signals (good performance + discomfort)
- Pump 1-2 for 2+ weeks (exercise not working)

#### Deload
Trigger: Every 4th week OR end of mesocycle OR user requests

Prescription:
- 50% volume (half the sets)
- RPE 5-6
- Same weights (maintain neural patterns)

#### Finding weight (Week 1 / new exercise)
- Pick weight that felt right
- Target top of rep range with consistency
- Don't progress — stabilise first

#### "Felt amazing" but missed reps
- Hold everything
- Accept higher RPE
- Don't chase numbers when stimulus is there

#### Drop sets
If exercise consistently drops off hard on later sets, allow drop set on final set rather than reducing weight across all sets.

#### Missed session
Carry forward unchanged.

#### Stall (same reps 2 weeks)
Consider adding a set.

#### Partial completion (fewer sets than planned)
Carry forward, note in review.

---

## Response Style

- Tables for summaries and proposed changes
- Show changes clearly before saving
- Always confirm before writing
- Go through exercises one by one if user requests

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
| DB Bench | 4×8 @32.5kg | 8,8,8,7 | 4×9,9,9,8 @32.5kg | +1 rep/set |
| Leg Press | 4×12 @140kg | 12,12,12,12 | 4×12 @145kg | +5kg (exceeded range) |
| Pull-ups | 3×6 @+10kg | 6,6,5 | 3×7,7,6 @+10kg | +1 rep/set |
| Lat Raise | 3×15 @10kg | 15,15,15, pump 5 | 4×15,15,15,15 @10kg | +1 set (high pump, low soreness) |

⚠️ Flag: Incline DB — shoulder discomfort 2 weeks. Swap?

User: Let's try cable fly

Claude: Swapped Incline DB → Cable Fly
Starting at 3×12 @12.5kg

Confirm Week 4?
```

**Example 3: Confirm and save**
```
User: Looks good, save it

Claude: ✓ Week 4 saved.

4 exercises progressed, 1 swapped, 2 held.
```
