---
name: gym-session
description: Guide a gym workout session from readiness check through set logging to session end. Use when user says they're at the gym, starting a workout, or names a training day.
---

# Gym Session

Structured gym workout flow. Handles readiness assessment, plan display, set logging, exercise feedback, and session wrap-up.

## Flow

### 1. Auto-detect today's session and display everything upfront

Call all of these in parallel:
- `sync_garmin_data` and `get_readiness`
- `get_active_mesocycle`

Then determine today's training day automatically:
- Query the most recent workout in this mesocycle (by date, descending)
- If last workout was Day N of M total days, today is Day (N % M) + 1
- If no workouts yet, start with Day 1
- If the last workout was more than 3 days ago, ask which day rather than auto-detecting -- a gap suggests the schedule may have shifted

Then call `get_workout_plan` for the detected day and week, and `get_exercise_cues` for all exercises.

**Present everything in the first response -- no questions asked:**

```
Day 2: Push -- Week 3

Garmin: Sleep 7h25m | BB 59 | Stress 10 | RHR 47

A1  Bench Press -- 4x4 @ 85kg (RPE 8, 3min rest)
    ↳ pause on chest, pinky on ring
B1  Pull Up -- 4x9 @ BW (RPE 7-8, 90s rest)
B2  Incline DB Press -- 3x8-10 @ 26kg (RPE 7-8, 60s rest)
...

Sleep / Energy / chest, back, shoulders, arms soreness:
```

Format each exercise from the `get_workout_plan` response fields:
- `target_rpe` (text, e.g. "8" or "7-8") → show as `(RPE 8)`. Omit if null.
- `rest_seconds` (integer) → show as `Xmin rest` if >= 60, `Xs rest` if < 60. Omit if null.
- `superset_group` → group exercises (A1, B1/B2, etc.)
- Exercise cues from `get_exercise_cues` → show with `↳` prefix
- `notes` from the plan → show if present

The example above uses sample values. Always read from the actual tool response.

If the user says "actually doing pull today" or names a specific day, switch without fuss.

The readiness prompt at the bottom asks for sleep (1-5), energy (1-5), and soreness (0-5) per muscle group trained today. Accept numeric or verbal. Parse what you can.

### 2. Flag discrepancies and start session

Compare objective Garmin data with subjective ratings. Only mention when there's a meaningful gap:
- Low BB but high energy? Proceed but note it.
- High BB but low energy? Trust how they feel.
- BB morning < 30? Suggest reduced volume or lighter session. Don't insist.

Call `start_workout` with:
- `mesocycle_id`, `mesocycle_day_id`, `week_number`
- `sleep_quality`, `energy_level`
- `muscle_soreness` as structured JSONB: `{"back": 2, "biceps": 1}`
- `pre_session_notes` if anything noteworthy from readiness

### 3. Exercise loop

This is the core of the session. For each exercise:

**Log sets:**
- Parse natural language: "80kg x 8", "did 8 at 80", "same as last set", "3 sets of 12", just "8 8 7"
- For weighted BW exercises: see project instructions (use `weight_added_kg` field)
- Call `log_sets` immediately. Don't batch -- log as reported.
- Confirm briefly: `Logged: Bench 80kg x 8, 8, 7` or `Logged: Pull Up BW+10kg x 5, 5, 4`
- Detect set types automatically: warmup, drop set, failure, rest-pause, myo reps.

**After each exercise, prompt for feedback:**
```
Pump / Joint:
```
Pump 1-5, Joint 0-5 (0 = none). Accept numeric (`4 0`) or verbal. Default to pump=3, joint=0 if skipped. Call `log_exercise_feedback`.

**Corrections:**
If the user says "that was wrong" or "change the last set" -- use `update_set` or `delete_set`.
Don't ask for confirmation on corrections -- just do it and confirm.

**Capture notes in real-time:**
If the user mentions something noteworthy (felt easy, grip failed, shoulder tweaked, weight felt light), store it as a note on the set or exercise immediately. Don't ask "want me to note that?" -- just do it.

### 4. End session

When the user says they're done, wrapping up, or it's clear the session is over:

- Call `end_workout`
- Show duration and total sets
- Prompt for overall rating (1-5) -- don't force it

## Mid-session flexibility

- **Exercise swap:** log the swap, use `search_exercises` to find the new exercise ID, continue.
- **Extra sets:** log it, no fuss.
- **Skipped exercise:** acknowledge, move on.
- **Early finish:** end the workout with whatever was logged.
- **Added exercises:** find the exercise, log sets.
- **Non-standard input:** Parse aggressively. "80 8 8 7" = 80kg for 8, 8, 7 reps.

## Response style during sessions

- 1-3 lines max per response. No essays.
- No "Great job!" or "Nice work!" after every set.
- Confirm data was logged, prompt for next input, move on.
- Save encouragement for genuinely notable moments (PR, completed a hard session).
