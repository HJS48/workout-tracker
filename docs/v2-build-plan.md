# V2 Build Plan — Training Block V2 Implementation

**Goal:** Update the entire system (DB, MCP, skills, PWA, project instructions) to support Training Block V2 by Monday March 9.

**Reference:** docs/training-block-v2.md

---

## Phase 1: Schema Migration

Single migration file: `supabase/migrations/20260306_training_block_v2.sql`

### 1.1 Add `target_rpe` to `weekly_targets`
```sql
ALTER TABLE weekly_targets ADD COLUMN target_rpe text;
```
- Stores RPE targets like "8", "7-8", "8-9"
- Used by gym-session skill to display RPE alongside sets/reps/weight
- Used by progression rules: RPE <9 → +2.5kg, RPE 10 → repeat

### 1.2 Add `weight_added_kg` to `workout_sets`
```sql
ALTER TABLE workout_sets ADD COLUMN weight_added_kg numeric;
```
- For weighted pull-ups, weighted dips — tracks the ADDED weight (belt/chain)
- `weight_kg` stays 0 for BW exercises; `weight_added_kg` = 10 means BW+10kg
- Logged sets display as "BW+10kg x 5"

### 1.3 Add `rest_seconds` to `weekly_targets`
```sql
ALTER TABLE weekly_targets ADD COLUMN rest_seconds integer;
```
- Stores prescribed rest between sets (180 = 3 min, 90 = 90s, 60 = 60s)
- Displayed in workout plan and used by PWA timer feature

### 1.4 Add run target fields to `run_sessions`
```sql
ALTER TABLE run_sessions
  ADD COLUMN target_cadence_spm integer,
  ADD COLUMN target_pace_s_per_km numeric,
  ADD COLUMN target_hr_min integer,
  ADD COLUMN target_hr_max integer;
```
- Cadence targets: 145 (W1-2), 150 (W3-4), 152-155 (W5-6)
- Pace targets: easy 6:30-7:30, tempo 5:30-5:50, intervals 4:25-4:40
- HR targets: easy <145, tempo 155-168, intervals 165-180

### 1.5 Create `weekly_run_targets` table
```sql
CREATE TABLE weekly_run_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mesocycle_id uuid NOT NULL REFERENCES mesocycles(id) ON DELETE CASCADE,
  week_number integer NOT NULL,
  day_of_week text NOT NULL,
  run_type text NOT NULL,
  duration_min integer,
  distance_km numeric,
  target_pace_text text,
  target_hr_text text,
  target_cadence_spm integer,
  intervals_count integer,
  interval_distance_m integer,
  interval_pace_text text,
  recovery_text text,
  warmup_text text,
  cooldown_text text,
  notes text,
  created_at timestamp DEFAULT now(),
  UNIQUE(mesocycle_id, week_number, day_of_week)
);
```
- Structured storage for all 18 run sessions across 6 weeks
- Replaces free-text in mesocycle.notes for running prescriptions
- Queried by run-session skill to show exact prescription

### 1.6 Update existing RPCs

**`save_weekly_targets`** — add `target_rpe` and `rest_seconds` to the JSONB insert:
```sql
-- Update the RPC to accept and store target_rpe + rest_seconds in the targets array items
```

**`log_sets`** — add `weight_added_kg` to the set insert:
```sql
-- Update the p_sets array item handling to include weight_added_kg
```

**`get_workout_plan`** — return `target_rpe` and `rest_seconds` in output:
```sql
-- Add target_rpe, rest_seconds to the json_build_object in the query
```

**`update_run_session`** — add target fields:
```sql
-- Add p_target_cadence_spm, p_target_pace_s_per_km, p_target_hr_min, p_target_hr_max
```

### 1.7 New RPCs

**`get_weekly_run_targets`** — fetch run prescriptions for a week:
```sql
CREATE OR REPLACE FUNCTION get_weekly_run_targets(
  p_mesocycle_id uuid,
  p_week_number integer
)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
  SELECT json_agg(row_to_json(t))
  FROM weekly_run_targets t
  WHERE mesocycle_id = p_mesocycle_id AND week_number = p_week_number
  ORDER BY day_of_week;
$$;
```

**`save_weekly_run_targets`** — bulk insert run targets for a week:
```sql
-- Similar pattern to save_weekly_targets: delete existing + insert new
```

---

## Phase 2: MCP Server Updates

File: `supabase/functions/mcp-server/index.ts`

### 2.1 Update existing tools

**`log_sets`** — add `weight_added_kg` to set schema:
```typescript
// In TOOLS array, log_sets.inputSchema.properties.sets.items.properties:
weight_added_kg: { type: 'number', description: 'Added weight for BW exercises (e.g. 10 for BW+10kg pull-ups)' },
```
```typescript
// In handleToolCall, pass through to RPC
```

**`save_weekly_targets`** — add `target_rpe` and `rest_seconds`:
```typescript
// In targets array item properties:
target_rpe: { type: 'string', description: 'Target RPE (e.g. "8", "7-8")' },
rest_seconds: { type: 'number', description: 'Rest between sets in seconds (e.g. 180 for 3 min)' },
```

**`update_weekly_target`** — add `target_rpe` and `rest_seconds`:
```typescript
// Same fields added to inputSchema and handler
```

**`update_run_session`** — add target fields:
```typescript
target_cadence_spm: { type: 'number', description: 'Target cadence in steps per minute' },
target_pace_s_per_km: { type: 'number', description: 'Target pace in seconds per km' },
target_hr_min: { type: 'number', description: 'Minimum target heart rate' },
target_hr_max: { type: 'number', description: 'Maximum target heart rate' },
```

**`update_set`** — add `weight_added_kg`:
```typescript
weight_added_kg: { type: 'number', description: 'Added weight for BW exercises' },
```

### 2.2 New tools

**`get_weekly_run_targets`** — fetch structured run prescriptions:
```typescript
{
  name: 'get_weekly_run_targets',
  description: 'Get the planned run sessions for a specific week. Shows run type, pace, HR targets, interval structure, cadence targets.',
  inputSchema: {
    type: 'object',
    properties: {
      mesocycle_id: { type: 'string', description: 'Mesocycle UUID' },
      week_number: { type: 'number', description: 'Week number' },
    },
    required: ['mesocycle_id', 'week_number'],
  },
}
```

**`save_weekly_run_targets`** — bulk save run targets:
```typescript
{
  name: 'save_weekly_run_targets',
  description: 'Save run session targets for a week. Replaces existing targets for that week.',
  inputSchema: {
    type: 'object',
    properties: {
      mesocycle_id: { type: 'string', description: 'Mesocycle UUID' },
      week_number: { type: 'number', description: 'Week number' },
      targets: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            day_of_week: { type: 'string', description: 'Day of week (tue, thu, sat)' },
            run_type: { type: 'string', description: 'Run type (easy, tempo, interval, long, fartlek, race)' },
            duration_min: { type: 'number' },
            distance_km: { type: 'number' },
            target_pace_text: { type: 'string', description: 'e.g. "6:30-7:30/km"' },
            target_hr_text: { type: 'string', description: 'e.g. "HR <145"' },
            target_cadence_spm: { type: 'number' },
            intervals_count: { type: 'number' },
            interval_distance_m: { type: 'number' },
            interval_pace_text: { type: 'string' },
            recovery_text: { type: 'string' },
            warmup_text: { type: 'string' },
            cooldown_text: { type: 'string' },
            notes: { type: 'string' },
          },
          required: ['day_of_week', 'run_type'],
        },
      },
    },
    required: ['mesocycle_id', 'week_number', 'targets'],
  },
}
```

Tool count: 29 → 31

---

## Phase 3: Create Mesocycle & Populate Data

### 3.1 Create new mesocycle via MCP

```
Name: "Hybrid Block V2"
Focus: "Modified DUP + Polarized Running"
Start date: 2026-03-09
End date: 2026-04-19
Days:
  1: "Upper A" (notes: "Bench Heavy + Pull-ups (BW submaximal). Heavy day: low reps, high intensity, 3 min rest on bench.")
  2: "Lower A" (notes: "Leg Press Heavy + Hamstrings + Calf/Tibialis prehab. Running support day.")
  3: "Upper B" (notes: "Bench Volume + Weighted Pull-ups. Volume day: higher reps, moderate weight, 2 min rest on bench.")
  4: "Lower B" (notes: "Accessories + Core + Shin prehab. Shortest session (35 min). Long run same day with 6h gap.")
Notes: [full mesocycle notes including progression rules, deload protocol, test week protocol, weekly structure, interference rules]
```

### 3.2 Search/create exercises

Need exercise IDs for new exercises not in the DB:
- Weighted Pull-Up (if not exists — may need separate from Pull Up, or use Pull Up with weight_added_kg)
- Dip
- DB Row (Single Arm)
- Face Pull
- Romanian DB Deadlift
- Walking Lunge (DB)
- Bulgarian Split Squat
- Nordic Hamstring Curl
- Pallof Press
- Calf Raise (Seated or Standing)
- Tibialis Raise

Use `search_exercises` first, then create any missing via direct DB insert.

### 3.3 Save weekly targets (all 6 weeks)

For each of weeks 1-6, call `save_weekly_targets` with the exact prescription from training-block-v2.md. This includes:
- Sets, reps, weight, RPE, rest_seconds for every exercise on every day
- Week 5 deload targets (reduced volume, lower RPE)
- Week 6 test targets (1RM protocol, AMRAP, etc.)

### 3.4 Save weekly run targets (all 6 weeks)

For each of weeks 1-6, call `save_weekly_run_targets` with:
- Tuesday: hard session prescription (easy/fartlek/intervals/tempo/sharpener)
- Thursday: easy run prescription (duration, cadence target)
- Saturday: long run prescription (duration, pace)

### 3.5 Update goals

Update existing goals to match V2 targets:
- Bench Press: 110kg (was 120kg)
- Pull Up: 16 reps (was 17)
- 5K: keep or adjust to 24:00 (1440 seconds)

---

## Phase 4: Gym-Session Skill Rewrite

File: `skills/gym-session/SKILL.md`

### Key changes:

**4.1 DUP context display**
When showing the plan, add day role context:
```
Day 1: Upper A — Bench Heavy + Pull-ups | Week 2

This is your STRENGTH day — low reps, heavy weight, long rest.
```
vs
```
Day 3: Upper B — Bench Volume + Weighted Pull-ups | Week 2

This is your VOLUME day — higher reps, moderate weight, controlled tempo.
```

**4.2 RPE + rest period display**
Show RPE and rest alongside every exercise:
```
A  Bench Press — 4x4 @ 85kg | RPE 8 | Rest 3 min
B1 Pull-Up (BW) — 4x9 | RPE 7 | Rest 90s
B2 Incline DB Press — 3x8-10 @ 26kg | RPE 7-8 | Rest 60s
```

**4.3 Weighted pull-up notation**
Display weighted exercises clearly:
```
B1 Weighted Pull-Up — 4x5 @ BW+10kg | RPE 7-8 | Rest 2 min
```

**4.4 Deload week auto-detection**
```
if week_number == 5:
  "DELOAD WEEK — 50-60% volume, RPE 5-6. Go light, stay sharp."
```

**4.5 Test week auto-detection**
```
if week_number == 6:
  Monday: "TEST DAY — Bench 1RM then Pull-up max reps. Warm-up protocol: Bar x10, 50kg x5, 70kg x3, 85kg x1, 95kg x1, 100kg x1, then max attempts. 10 min rest before pull-ups."
  Friday: "REST DAY — No gym. Preserve CNS for tomorrow's 5K time trial."
```

**4.6 Warm-up protocol display**
Show before exercises on every gym day:
```
Warm-up (8 min):
1. Band pull-aparts 2x15
2. Shoulder dislocates 2x10
3. Cat-cow 10 reps
4. Dead bugs 2x8 each side
5. Specific: [progressive sets for first exercise]
```

**4.7 Pull-up drop-off tracking**
After logging pull-up sets, calculate and comment on drop-off:
```
Pull-ups: 10, 9, 8, 8 (35 total, 20% drop-off — improving from 42%)
```

**4.8 RPE mismatch flagging**
If logged RPE significantly misses target:
```
RPE 10 on set 1 — target was RPE 8. Consider dropping 2.5kg next set.
```

---

## Phase 5: Run-Session Skill Rewrite

File: `skills/run-session/SKILL.md`

### Key changes:

**5.1 Structured prescription from DB**
Instead of parsing mesocycle.notes, call `get_weekly_run_targets` for today's day:
```
Planned: Intervals — 5x600m @ 4:30-4:40/km
10 min easy warm-up | 600m reps w/ 2 min jog recovery | 5 min cool-down
Target HR on reps: 165-175 | Cadence: 150 spm
```

**5.2 Pre-run shin splint check**
Add before readiness prompt:
```
Shin check: Any shin pain right now? (yes/no)
```
- If yes at run START → "Stop. Bike 30 min at HR 120-140 instead."
- Build into the flow before Step 4 (intensity recommendation)

**5.3 Cadence target display**
Show weekly cadence target on every run:
```
Cadence target this week: 150 spm (use metronome app)
```

**5.4 Heat-adjusted pacing**
If temperature data available from Garmin or known (Brescia):
```
Note: 26C today. Add 15-30s/km to easy pace. Run by HR (<145), not pace.
```

**5.5 Post-run cadence review**
After run syncs, compare actual vs target cadence:
```
Cadence: 148 spm (target: 150) — close, keep working on it
```

**5.6 Weekly mileage tracking**
Show running volume context:
```
This week so far: 8.2km / 16-18km target
```

**5.7 5K time trial protocol (Week 6)**
Auto-detect test week Saturday and display full pacing strategy:
```
5K TIME TRIAL — Target: 24:00-24:30 (4:48-4:54/km)

Pre-race: Light carb meal 2-3h before, 10 min easy jog, 4x100m strides

Pacing:
Km 1: 4:55 (hold back — this should feel too easy)
Km 2: 4:50 (settle in, find rhythm)
Km 3: 4:50 (halfway — if you feel good, hold)
Km 4: 4:45 (start pushing)
Km 5: 4:40+ (everything left, sprint last 200m)

If >25C: add 10-15s/km. Consider early morning (7-8 AM).
```

---

## Phase 6: Project Instructions Update

File: `docs/claude-ai-project-instructions.md`

### Key changes:

- Update "Current block" to Hybrid Block V2
- Update goals to V2 targets (bench 110kg, pull-ups 16, 5K 24:00-24:30)
- Add DUP explanation (heavy Monday, volume Thursday)
- Add weekly structure (Mon Upper A, Tue hard run, Wed Lower A, Thu Upper B + easy run PM, Fri Lower B, Sat long run, Sun rest)
- Add deload/test week rules
- Add shin splint decision tree
- Add cadence progression targets
- Add heat adjustment rules for Brescia
- Add interference management rules
- Add 5K time trial pacing strategy
- Remove stale references to 3-day split, Push/Pull/Push+Pull

---

## Phase 7: PWA Enhancements

File: `docs/pwa/app.js` + `docs/pwa/index.html`

### 7.1 RPE display in exercise cards
Show target RPE alongside sets/reps/weight:
```
Bench Press — 4x4 @ 85kg (RPE 8)
```

### 7.2 Rest period display + optional timer
Show rest target per exercise. Optional: tap-to-start countdown timer.

### 7.3 Weighted pull-up display
Show "BW+10kg" not just "10kg" for exercises with weight_added_kg.

### 7.4 Warm-up protocol screen
Show warm-up checklist before exercise list on session start.

### 7.5 Deload/test week indicator
Visual banner at top of session:
```
WEEK 5 — DELOAD | 50% volume, RPE 5-6
```
or
```
WEEK 6 — TEST WEEK | 1RM Bench + Pull-up Max
```

### 7.6 Handle `weight_added_kg` in set logging
When logging a weighted BW exercise, input field shows "+kg" prefix.

---

## Execution Order

| Step | Task | Depends On | Est. Effort |
|------|------|------------|-------------|
| 1 | Write + apply migration SQL | Nothing | Small |
| 2 | Update RPCs (save_weekly_targets, log_sets, get_workout_plan, update_run_session, update_set) | Step 1 |  Medium |
| 3 | Create new RPCs (get_weekly_run_targets, save_weekly_run_targets) | Step 1 | Small |
| 4 | Update MCP server (add fields to existing tools, add 2 new tools) | Steps 2-3 | Medium |
| 5 | Deploy MCP server | Step 4 | Small |
| 6 | Create mesocycle + search/create exercises | Step 5 | Medium |
| 7 | Populate all 6 weeks of gym targets | Step 6 | Medium |
| 8 | Populate all 6 weeks of run targets | Step 6 | Medium |
| 9 | Update goals | Step 6 | Small |
| 10 | Rewrite gym-session skill | Steps 4-5 | Medium |
| 11 | Rewrite run-session skill | Steps 4-5 | Medium |
| 12 | Update project instructions | Step 6 | Small |
| 13 | PWA enhancements | Steps 1-2 | Medium |
| 14 | Zip + upload skills to Claude.ai | Steps 10-11 | Small |
| 15 | Re-paste project instructions to Claude.ai | Step 12 | Small |
| 16 | End-to-end test (log a mock session) | Steps 5-15 | Small |

Steps 1-5 are sequential (schema → RPCs → MCP).
Steps 6-9 are sequential (create meso → populate).
Steps 10-13 can run in parallel after Step 5.
Steps 14-16 are final validation.

---

## Validation Checklist

- [ ] Weighted pull-up: log 4x5 @ BW+10kg, verify weight_added_kg stored correctly
- [ ] RPE target: get_workout_plan returns target_rpe for bench
- [ ] Rest period: get_workout_plan returns rest_seconds
- [ ] DUP: Bench appears on Upper A (4x4 @ 85kg RPE 8) AND Upper B (3x8 @ 70kg RPE 7-8)
- [ ] Run target: get_weekly_run_targets returns Tuesday interval prescription
- [ ] Cadence target: run target shows target_cadence_spm = 145 for Week 1
- [ ] Deload: Week 5 targets show reduced volume and RPE 5-6
- [ ] Test week: Week 6 bench target is 1x1 (work up to max)
- [ ] Gym skill: displays RPE, rest, warm-up, DUP context
- [ ] Run skill: displays interval structure, shin check, cadence target
- [ ] PWA: shows RPE in exercise cards, handles weighted BW exercises
- [ ] Project instructions: reflect V2 structure and targets
