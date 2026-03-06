

I now have all the information needed to produce the comprehensive build plan. Since this is a read-only task and I cannot write files, I will present the complete plan directly in my response.

---

# Workout Tracker Custom MCP Server + Strava Integration -- Build Plan

**Project:** Workout Tracker
**Supabase URL:** `https://xwfshemzhunaxbzjgata.supabase.co`
**Date:** 2026-02-28
**Status:** No existing edge functions or RPC functions. Clean slate.

---

## 1. New Tables

### 1.1 `strava_tokens`

Stores the OAuth tokens for the single Strava user (single-user app).

```sql
CREATE TABLE strava_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id bigint NOT NULL UNIQUE,
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  expires_at bigint NOT NULL,          -- unix timestamp
  scope text,                          -- e.g. 'activity:read_all'
  athlete_json jsonb,                  -- summary athlete from initial auth
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Only one row expected, but UNIQUE on athlete_id enforces it
CREATE INDEX idx_strava_tokens_athlete_id ON strava_tokens(athlete_id);
```

### 1.2 `strava_webhook_subscriptions`

Stores the active webhook subscription ID for management.

```sql
CREATE TABLE strava_webhook_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id bigint NOT NULL UNIQUE,
  callback_url text NOT NULL,
  created_at timestamptz DEFAULT now()
);
```

### 1.3 `strava_sync_log`

Audit log for every sync attempt (debugging, dedup).

```sql
CREATE TABLE strava_sync_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strava_activity_id bigint NOT NULL,
  event_type text NOT NULL,            -- 'create', 'update', 'delete'
  status text NOT NULL,                -- 'success', 'skipped', 'error'
  run_session_id uuid REFERENCES run_sessions(id),
  error_message text,
  raw_payload jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_strava_sync_log_activity ON strava_sync_log(strava_activity_id);
```

---

## 2. Database Functions (RPC)

Every function is `SECURITY DEFINER` with `search_path = public` so the edge function calls them via `supabase.rpc()` with the service role key. No raw SQL from the edge function.

### 2.1 `get_active_mesocycle`

```sql
CREATE OR REPLACE FUNCTION get_active_mesocycle()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result json;
BEGIN
  SELECT json_build_object(
    'id', m.id,
    'name', m.name,
    'focus', m.focus,
    'start_date', m.start_date,
    'end_date', m.end_date,
    'status', m.status,
    'notes', m.notes,
    'days', (
      SELECT json_agg(json_build_object(
        'id', md.id,
        'day_number', md.day_number,
        'name', md.name,
        'notes', md.notes
      ) ORDER BY md.day_number)
      FROM mesocycle_days md
      WHERE md.mesocycle_id = m.id
    )
  ) INTO result
  FROM mesocycles m
  WHERE m.status = 'active'
  LIMIT 1;

  RETURN COALESCE(result, '{"error": "no active mesocycle"}'::json);
END;
$$;
```

**Tool:** `get_active_mesocycle`
**Params:** none
**Returns:**
```json
{
  "id": "uuid",
  "name": "string",
  "focus": "string",
  "start_date": "date",
  "end_date": "date|null",
  "status": "string",
  "notes": "string|null",
  "days": [
    { "id": "uuid", "day_number": 1, "name": "Pull", "notes": "string|null" }
  ]
}
```

### 2.2 `get_workout_plan`

Returns the weekly targets for a specific day and week, with exercise details.

```sql
CREATE OR REPLACE FUNCTION get_workout_plan(
  p_mesocycle_id uuid,
  p_day_id uuid,
  p_week_number integer
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result json;
BEGIN
  -- First try weekly_targets for the specific week
  SELECT json_agg(json_build_object(
    'id', wt.id,
    'exercise_id', wt.exercise_id,
    'exercise_name', e.name,
    'muscle_group', e.muscle_group,
    'equipment', e.equipment,
    'exercise_order', wt.exercise_order,
    'target_sets', wt.target_sets,
    'target_reps', wt.target_reps,
    'target_weight_kg', wt.target_weight_kg,
    'superset_group', wt.superset_group,
    'notes', wt.notes
  ) ORDER BY wt.exercise_order)
  INTO result
  FROM weekly_targets wt
  JOIN exercises e ON e.id = wt.exercise_id
  WHERE wt.mesocycle_id = p_mesocycle_id
    AND wt.mesocycle_day_id = p_day_id
    AND wt.week_number = p_week_number;

  -- Fall back to mesocycle_planned_exercises if no weekly targets
  IF result IS NULL THEN
    SELECT json_agg(json_build_object(
      'exercise_id', mpe.exercise_id,
      'exercise_name', e.name,
      'muscle_group', e.muscle_group,
      'equipment', e.equipment,
      'exercise_order', mpe.exercise_order,
      'target_sets', mpe.target_sets,
      'target_reps', mpe.target_reps,
      'target_weight_kg', null,
      'target_rpe', mpe.target_rpe,
      'superset_group', null,
      'notes', mpe.notes
    ) ORDER BY mpe.exercise_order)
    INTO result
    FROM mesocycle_planned_exercises mpe
    JOIN exercises e ON e.id = mpe.exercise_id
    WHERE mpe.mesocycle_day_id = p_day_id;
  END IF;

  RETURN COALESCE(result, '[]'::json);
END;
$$;
```

### 2.3 `start_workout`

Creates a workout record and returns the ID.

```sql
CREATE OR REPLACE FUNCTION start_workout(
  p_mesocycle_id uuid,
  p_mesocycle_day_id uuid,
  p_week_number integer,
  p_date date DEFAULT CURRENT_DATE,
  p_sleep_quality integer DEFAULT NULL,
  p_energy_level integer DEFAULT NULL,
  p_muscle_soreness jsonb DEFAULT NULL,
  p_pre_session_notes text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_id uuid;
BEGIN
  INSERT INTO workouts (
    mesocycle_id, mesocycle_day_id, week_number, date,
    started_at, sleep_quality, energy_level, muscle_soreness, pre_session_notes
  ) VALUES (
    p_mesocycle_id, p_mesocycle_day_id, p_week_number, p_date,
    now(), p_sleep_quality, p_energy_level, p_muscle_soreness, p_pre_session_notes
  )
  RETURNING id INTO new_id;

  RETURN json_build_object('workout_id', new_id);
END;
$$;
```

### 2.4 `log_sets`

Logs one or more sets for an exercise in a workout. Accepts a JSON array.

```sql
CREATE OR REPLACE FUNCTION log_sets(
  p_workout_id uuid,
  p_exercise_id uuid,
  p_sets jsonb  -- array of { weight_kg, reps, rpe, set_type, notes }
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  set_record jsonb;
  current_order integer;
  inserted_count integer := 0;
BEGIN
  -- Get the next set_order for this workout
  SELECT COALESCE(MAX(set_order), 0) INTO current_order
  FROM workout_sets
  WHERE workout_id = p_workout_id;

  FOR set_record IN SELECT * FROM jsonb_array_elements(p_sets)
  LOOP
    current_order := current_order + 1;
    INSERT INTO workout_sets (
      workout_id, exercise_id, set_order,
      weight_kg, reps, rpe, set_type, notes
    ) VALUES (
      p_workout_id,
      p_exercise_id,
      current_order,
      (set_record->>'weight_kg')::numeric,
      (set_record->>'reps')::integer,
      (set_record->>'rpe')::numeric,
      set_record->>'set_type',
      set_record->>'notes'
    );
    inserted_count := inserted_count + 1;
  END LOOP;

  RETURN json_build_object(
    'logged', inserted_count,
    'exercise_id', p_exercise_id,
    'workout_id', p_workout_id
  );
END;
$$;
```

### 2.5 `log_exercise_feedback`

Stores pump/joint feedback for an exercise.

```sql
CREATE OR REPLACE FUNCTION log_exercise_feedback(
  p_workout_id uuid,
  p_exercise_id uuid,
  p_pump_quality integer DEFAULT NULL,
  p_joint_discomfort integer DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_id uuid;
BEGIN
  INSERT INTO workout_exercise_notes (
    workout_id, exercise_id, pump_quality, joint_discomfort, notes
  ) VALUES (
    p_workout_id, p_exercise_id, p_pump_quality, p_joint_discomfort, COALESCE(p_notes, '')
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO new_id;

  -- If conflict (already exists), update instead
  IF new_id IS NULL THEN
    UPDATE workout_exercise_notes
    SET pump_quality = COALESCE(p_pump_quality, pump_quality),
        joint_discomfort = COALESCE(p_joint_discomfort, joint_discomfort),
        notes = CASE WHEN p_notes IS NOT NULL THEN p_notes ELSE notes END
    WHERE workout_id = p_workout_id AND exercise_id = p_exercise_id
    RETURNING id INTO new_id;
  END IF;

  RETURN json_build_object('id', new_id);
END;
$$;
```

**Note:** The `workout_exercise_notes` table does not currently have a unique constraint on `(workout_id, exercise_id)`. A migration should add one:

```sql
ALTER TABLE workout_exercise_notes
  ADD CONSTRAINT uq_workout_exercise_notes_workout_exercise
  UNIQUE (workout_id, exercise_id);
```

### 2.6 `end_workout`

```sql
CREATE OR REPLACE FUNCTION end_workout(
  p_workout_id uuid,
  p_rating integer DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result json;
BEGIN
  UPDATE workouts
  SET ended_at = now(),
      rating = COALESCE(p_rating, rating),
      notes = COALESCE(p_notes, notes)
  WHERE id = p_workout_id
  RETURNING json_build_object(
    'workout_id', id,
    'started_at', started_at,
    'ended_at', ended_at,
    'duration_min', EXTRACT(EPOCH FROM (ended_at - started_at)) / 60
  ) INTO result;

  RETURN COALESCE(result, json_build_object('error', 'workout not found'));
END;
$$;
```

### 2.7 `get_workout_review`

Pulls actual vs planned for a completed workout.

```sql
CREATE OR REPLACE FUNCTION get_workout_review(
  p_workout_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  workout_data json;
  sets_data json;
  feedback_data json;
BEGIN
  -- Workout metadata
  SELECT json_build_object(
    'id', w.id,
    'date', w.date,
    'week_number', w.week_number,
    'day_name', md.name,
    'mesocycle_name', m.name,
    'started_at', w.started_at,
    'ended_at', w.ended_at,
    'rating', w.rating,
    'notes', w.notes,
    'sleep_quality', w.sleep_quality,
    'energy_level', w.energy_level,
    'muscle_soreness', w.muscle_soreness,
    'pre_session_notes', w.pre_session_notes
  ) INTO workout_data
  FROM workouts w
  LEFT JOIN mesocycle_days md ON w.mesocycle_day_id = md.id
  LEFT JOIN mesocycles m ON w.mesocycle_id = m.id
  WHERE w.id = p_workout_id;

  -- All sets grouped by exercise
  SELECT json_agg(json_build_object(
    'exercise_id', e.id,
    'exercise_name', e.name,
    'muscle_group', e.muscle_group,
    'set_order', ws.set_order,
    'weight_kg', ws.weight_kg,
    'reps', ws.reps,
    'rpe', ws.rpe,
    'set_type', ws.set_type,
    'notes', ws.notes
  ) ORDER BY ws.set_order)
  INTO sets_data
  FROM workout_sets ws
  JOIN exercises e ON ws.exercise_id = e.id
  WHERE ws.workout_id = p_workout_id;

  -- Exercise feedback
  SELECT json_agg(json_build_object(
    'exercise_id', wen.exercise_id,
    'exercise_name', e.name,
    'pump_quality', wen.pump_quality,
    'joint_discomfort', wen.joint_discomfort,
    'notes', wen.notes
  ))
  INTO feedback_data
  FROM workout_exercise_notes wen
  JOIN exercises e ON wen.exercise_id = e.id
  WHERE wen.workout_id = p_workout_id;

  RETURN json_build_object(
    'workout', workout_data,
    'sets', COALESCE(sets_data, '[]'::json),
    'feedback', COALESCE(feedback_data, '[]'::json)
  );
END;
$$;
```

### 2.8 `get_week_summary`

Returns all workouts and sets for a given week in the active mesocycle.

```sql
CREATE OR REPLACE FUNCTION get_week_summary(
  p_mesocycle_id uuid,
  p_week_number integer
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result json;
BEGIN
  SELECT json_build_object(
    'mesocycle_id', p_mesocycle_id,
    'week_number', p_week_number,
    'workouts', (
      SELECT json_agg(json_build_object(
        'workout_id', w.id,
        'date', w.date,
        'day_name', md.name,
        'rating', w.rating,
        'sleep_quality', w.sleep_quality,
        'energy_level', w.energy_level,
        'muscle_soreness', w.muscle_soreness,
        'pre_session_notes', w.pre_session_notes,
        'notes', w.notes,
        'started_at', w.started_at,
        'ended_at', w.ended_at,
        'sets', (
          SELECT json_agg(json_build_object(
            'exercise_id', e.id,
            'exercise_name', e.name,
            'muscle_group', e.muscle_group,
            'set_order', ws.set_order,
            'weight_kg', ws.weight_kg,
            'reps', ws.reps,
            'rpe', ws.rpe,
            'set_type', ws.set_type,
            'notes', ws.notes
          ) ORDER BY ws.set_order)
          FROM workout_sets ws
          JOIN exercises e ON ws.exercise_id = e.id
          WHERE ws.workout_id = w.id
        ),
        'exercise_feedback', (
          SELECT json_agg(json_build_object(
            'exercise_id', wen.exercise_id,
            'exercise_name', e.name,
            'pump_quality', wen.pump_quality,
            'joint_discomfort', wen.joint_discomfort,
            'notes', wen.notes
          ))
          FROM workout_exercise_notes wen
          JOIN exercises e ON wen.exercise_id = e.id
          WHERE wen.workout_id = w.id
        )
      ) ORDER BY w.date)
      FROM workouts w
      LEFT JOIN mesocycle_days md ON w.mesocycle_day_id = md.id
      WHERE w.mesocycle_id = p_mesocycle_id
        AND w.week_number = p_week_number
    ),
    'targets', (
      SELECT json_agg(json_build_object(
        'exercise_id', wt.exercise_id,
        'exercise_name', e.name,
        'day_id', wt.mesocycle_day_id,
        'day_name', md.name,
        'exercise_order', wt.exercise_order,
        'target_sets', wt.target_sets,
        'target_reps', wt.target_reps,
        'target_weight_kg', wt.target_weight_kg,
        'superset_group', wt.superset_group,
        'notes', wt.notes
      ) ORDER BY md.day_number, wt.exercise_order)
      FROM weekly_targets wt
      JOIN exercises e ON e.id = wt.exercise_id
      JOIN mesocycle_days md ON wt.mesocycle_day_id = md.id
      WHERE wt.mesocycle_id = p_mesocycle_id
        AND wt.week_number = p_week_number
    )
  ) INTO result;

  RETURN result;
END;
$$;
```

### 2.9 `save_weekly_targets`

Bulk upsert weekly targets for the next week. Accepts JSON array.

```sql
CREATE OR REPLACE FUNCTION save_weekly_targets(
  p_mesocycle_id uuid,
  p_week_number integer,
  p_targets jsonb  -- array of { mesocycle_day_id, exercise_id, exercise_order, target_sets, target_reps, target_weight_kg, superset_group, notes }
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target jsonb;
  inserted_count integer := 0;
BEGIN
  -- Delete existing targets for this week (replace strategy)
  DELETE FROM weekly_targets
  WHERE mesocycle_id = p_mesocycle_id AND week_number = p_week_number;

  FOR target IN SELECT * FROM jsonb_array_elements(p_targets)
  LOOP
    INSERT INTO weekly_targets (
      mesocycle_id, week_number, mesocycle_day_id, exercise_id,
      exercise_order, target_sets, target_reps, target_weight_kg,
      superset_group, notes
    ) VALUES (
      p_mesocycle_id,
      p_week_number,
      (target->>'mesocycle_day_id')::uuid,
      (target->>'exercise_id')::uuid,
      (target->>'exercise_order')::integer,
      (target->>'target_sets')::integer,
      target->>'target_reps',
      (target->>'target_weight_kg')::numeric,
      target->>'superset_group',
      target->>'notes'
    );
    inserted_count := inserted_count + 1;
  END LOOP;

  RETURN json_build_object('saved', inserted_count, 'week', p_week_number);
END;
$$;
```

### 2.10 `get_exercise_history`

Returns progression data for one or more exercises.

```sql
CREATE OR REPLACE FUNCTION get_exercise_history(
  p_exercise_id uuid,
  p_limit integer DEFAULT 20
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result json;
BEGIN
  SELECT json_agg(row_data ORDER BY date DESC)
  INTO result
  FROM (
    SELECT json_build_object(
      'date', ep.date,
      'week_number', ep.week_number,
      'mesocycle_name', ep.mesocycle_name,
      'max_weight_kg', ep.max_weight_kg,
      'reps_at_max_weight', ep.reps_at_max_weight
    ) AS row_data, ep.date
    FROM exercise_progression ep
    WHERE ep.exercise_id = p_exercise_id
    ORDER BY ep.date DESC
    LIMIT p_limit
  ) sub;

  RETURN COALESCE(result, '[]'::json);
END;
$$;
```

### 2.11 `get_volume_summary`

Returns weekly volume by muscle group for a mesocycle.

```sql
CREATE OR REPLACE FUNCTION get_volume_summary(
  p_mesocycle_id uuid DEFAULT NULL,
  p_weeks integer DEFAULT 4
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result json;
  target_meso_id uuid;
BEGIN
  -- Default to active mesocycle
  IF p_mesocycle_id IS NULL THEN
    SELECT id INTO target_meso_id FROM mesocycles WHERE status = 'active' LIMIT 1;
  ELSE
    target_meso_id := p_mesocycle_id;
  END IF;

  SELECT json_agg(json_build_object(
    'week_number', wv.week_number,
    'muscle_group', wv.muscle_group,
    'total_sets', wv.total_sets,
    'total_volume_kg', wv.total_volume_kg
  ) ORDER BY wv.week_number, wv.muscle_group)
  INTO result
  FROM weekly_volume_by_muscle wv
  WHERE wv.mesocycle_id = target_meso_id;

  RETURN COALESCE(result, '[]'::json);
END;
$$;
```

### 2.12 `get_goals`

```sql
CREATE OR REPLACE FUNCTION get_goals(
  p_status text DEFAULT 'active'  -- 'active', 'achieved', 'all'
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result json;
BEGIN
  SELECT json_agg(json_build_object(
    'id', g.id,
    'exercise_id', g.exercise_id,
    'exercise_name', e.name,
    'mesocycle_id', g.mesocycle_id,
    'goal_type', g.goal_type,
    'target_value', g.target_value,
    'target_reps', g.target_reps,
    'target_date', g.target_date,
    'achieved_at', g.achieved_at,
    'notes', g.notes,
    'current_best', (
      SELECT json_build_object(
        'max_weight_kg', ep.max_weight_kg,
        'reps_at_max_weight', ep.reps_at_max_weight,
        'date', ep.date
      )
      FROM exercise_progression ep
      WHERE ep.exercise_id = g.exercise_id
      ORDER BY ep.date DESC
      LIMIT 1
    )
  ))
  INTO result
  FROM goals g
  LEFT JOIN exercises e ON g.exercise_id = e.id
  WHERE CASE
    WHEN p_status = 'active' THEN g.achieved_at IS NULL
    WHEN p_status = 'achieved' THEN g.achieved_at IS NOT NULL
    ELSE TRUE
  END;

  RETURN COALESCE(result, '[]'::json);
END;
$$;
```

### 2.13 `upsert_goal`

```sql
CREATE OR REPLACE FUNCTION upsert_goal(
  p_exercise_id uuid,
  p_goal_type text,
  p_target_value numeric,
  p_target_reps integer DEFAULT NULL,
  p_target_date date DEFAULT NULL,
  p_mesocycle_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_id uuid DEFAULT NULL  -- pass existing ID to update
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result_id uuid;
BEGIN
  IF p_id IS NOT NULL THEN
    UPDATE goals
    SET exercise_id = p_exercise_id,
        goal_type = p_goal_type,
        target_value = p_target_value,
        target_reps = COALESCE(p_target_reps, target_reps),
        target_date = COALESCE(p_target_date, target_date),
        mesocycle_id = COALESCE(p_mesocycle_id, mesocycle_id),
        notes = COALESCE(p_notes, notes)
    WHERE id = p_id
    RETURNING id INTO result_id;
  ELSE
    INSERT INTO goals (exercise_id, goal_type, target_value, target_reps, target_date, mesocycle_id, notes)
    VALUES (p_exercise_id, p_goal_type, p_target_value, p_target_reps, p_target_date, p_mesocycle_id, p_notes)
    RETURNING id INTO result_id;
  END IF;

  RETURN json_build_object('goal_id', result_id);
END;
$$;
```

### 2.14 `mark_goal_achieved`

```sql
CREATE OR REPLACE FUNCTION mark_goal_achieved(p_goal_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE goals SET achieved_at = now() WHERE id = p_goal_id;
  RETURN json_build_object('goal_id', p_goal_id, 'achieved_at', now());
END;
$$;
```

### 2.15 `search_exercises`

```sql
CREATE OR REPLACE FUNCTION search_exercises(
  p_query text DEFAULT NULL,
  p_muscle_group text DEFAULT NULL,
  p_equipment text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result json;
BEGIN
  SELECT json_agg(json_build_object(
    'id', e.id,
    'name', e.name,
    'muscle_group', e.muscle_group,
    'equipment', e.equipment,
    'movement_pattern', e.movement_pattern,
    'notes', e.notes
  ) ORDER BY e.name)
  INTO result
  FROM exercises e
  WHERE (p_query IS NULL OR e.name ILIKE '%' || p_query || '%')
    AND (p_muscle_group IS NULL OR e.muscle_group = p_muscle_group)
    AND (p_equipment IS NULL OR e.equipment = p_equipment);

  RETURN COALESCE(result, '[]'::json);
END;
$$;
```

### 2.16 `create_mesocycle`

```sql
CREATE OR REPLACE FUNCTION create_mesocycle(
  p_name text,
  p_focus text,
  p_start_date date,
  p_end_date date DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_days jsonb DEFAULT NULL  -- array of { day_number, name, notes }
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_meso_id uuid;
  day_record jsonb;
BEGIN
  -- Deactivate any currently active mesocycle
  UPDATE mesocycles SET status = 'completed' WHERE status = 'active';

  INSERT INTO mesocycles (name, focus, start_date, end_date, status, notes)
  VALUES (p_name, p_focus, p_start_date, p_end_date, 'active', p_notes)
  RETURNING id INTO new_meso_id;

  -- Insert days if provided
  IF p_days IS NOT NULL THEN
    FOR day_record IN SELECT * FROM jsonb_array_elements(p_days)
    LOOP
      INSERT INTO mesocycle_days (mesocycle_id, day_number, name, notes)
      VALUES (
        new_meso_id,
        (day_record->>'day_number')::integer,
        day_record->>'name',
        day_record->>'notes'
      );
    END LOOP;
  END IF;

  RETURN json_build_object('mesocycle_id', new_meso_id);
END;
$$;
```

### 2.17 `get_run_sessions`

```sql
CREATE OR REPLACE FUNCTION get_run_sessions(
  p_limit integer DEFAULT 10,
  p_run_type text DEFAULT NULL,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result json;
BEGIN
  SELECT json_agg(json_build_object(
    'id', rs.id,
    'date', rs.date,
    'run_type', rs.run_type,
    'distance_m', rs.distance_m,
    'duration_s', rs.duration_s,
    'avg_pace_s_per_km', rs.avg_pace_s_per_km,
    'avg_heart_rate', rs.avg_heart_rate,
    'max_heart_rate', rs.max_heart_rate,
    'avg_cadence', rs.avg_cadence,
    'elevation_gain_m', rs.elevation_gain_m,
    'calories', rs.calories,
    'perceived_effort', rs.perceived_effort,
    'notes', rs.notes,
    'source', rs.source,
    'external_id', rs.external_id
  ) ORDER BY rs.date DESC)
  INTO result
  FROM run_sessions rs
  WHERE (p_run_type IS NULL OR rs.run_type = p_run_type)
    AND (p_date_from IS NULL OR rs.date >= p_date_from)
    AND (p_date_to IS NULL OR rs.date <= p_date_to)
  LIMIT p_limit;

  RETURN COALESCE(result, '[]'::json);
END;
$$;
```

### 2.18 `get_run_detail`

Returns a full run session with laps and HR zones.

```sql
CREATE OR REPLACE FUNCTION get_run_detail(p_run_session_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result json;
BEGIN
  SELECT json_build_object(
    'session', (
      SELECT row_to_json(rs.*)
      FROM run_sessions rs
      WHERE rs.id = p_run_session_id
    ),
    'laps', (
      SELECT json_agg(row_to_json(rl.*) ORDER BY rl.lap_number)
      FROM run_laps rl
      WHERE rl.run_session_id = p_run_session_id
    ),
    'hr_zones', (
      SELECT json_agg(row_to_json(rz.*) ORDER BY rz.zone_number)
      FROM run_hr_zones rz
      WHERE rz.run_session_id = p_run_session_id
    )
  ) INTO result;

  RETURN result;
END;
$$;
```

### 2.19 `upsert_run_session`

Used by the Strava webhook to insert or update a run session.

```sql
CREATE OR REPLACE FUNCTION upsert_run_session(
  p_external_id text,
  p_source text,
  p_date date,
  p_started_at timestamptz DEFAULT NULL,
  p_ended_at timestamptz DEFAULT NULL,
  p_run_type text DEFAULT NULL,
  p_distance_m numeric DEFAULT NULL,
  p_duration_s numeric DEFAULT NULL,
  p_avg_pace_s_per_km numeric DEFAULT NULL,
  p_avg_heart_rate integer DEFAULT NULL,
  p_max_heart_rate integer DEFAULT NULL,
  p_avg_cadence integer DEFAULT NULL,
  p_elevation_gain_m numeric DEFAULT NULL,
  p_elevation_loss_m numeric DEFAULT NULL,
  p_calories integer DEFAULT NULL,
  p_perceived_effort integer DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_laps jsonb DEFAULT NULL,      -- array of lap objects
  p_hr_zones jsonb DEFAULT NULL   -- array of hr zone objects
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  session_id uuid;
  active_meso_id uuid;
  lap jsonb;
  zone jsonb;
  is_new boolean := false;
BEGIN
  -- Get active mesocycle
  SELECT id INTO active_meso_id FROM mesocycles WHERE status = 'active' LIMIT 1;

  -- Check if this external_id already exists
  SELECT id INTO session_id
  FROM run_sessions
  WHERE external_id = p_external_id AND source = p_source;

  IF session_id IS NOT NULL THEN
    -- Update existing
    UPDATE run_sessions SET
      date = p_date,
      started_at = COALESCE(p_started_at, started_at),
      ended_at = COALESCE(p_ended_at, ended_at),
      run_type = COALESCE(p_run_type, run_type),
      distance_m = COALESCE(p_distance_m, distance_m),
      duration_s = COALESCE(p_duration_s, duration_s),
      avg_pace_s_per_km = COALESCE(p_avg_pace_s_per_km, avg_pace_s_per_km),
      avg_heart_rate = COALESCE(p_avg_heart_rate, avg_heart_rate),
      max_heart_rate = COALESCE(p_max_heart_rate, max_heart_rate),
      avg_cadence = COALESCE(p_avg_cadence, avg_cadence),
      elevation_gain_m = COALESCE(p_elevation_gain_m, elevation_gain_m),
      elevation_loss_m = COALESCE(p_elevation_loss_m, elevation_loss_m),
      calories = COALESCE(p_calories, calories),
      perceived_effort = COALESCE(p_perceived_effort, perceived_effort),
      notes = COALESCE(p_notes, notes)
    WHERE id = session_id;

    -- Delete existing laps/zones for replacement
    DELETE FROM run_laps WHERE run_session_id = session_id;
    DELETE FROM run_hr_zones WHERE run_session_id = session_id;
  ELSE
    -- Insert new
    INSERT INTO run_sessions (
      external_id, source, date, started_at, ended_at, run_type,
      distance_m, duration_s, avg_pace_s_per_km,
      avg_heart_rate, max_heart_rate, avg_cadence,
      elevation_gain_m, elevation_loss_m, calories,
      perceived_effort, notes, mesocycle_id
    ) VALUES (
      p_external_id, p_source, p_date, p_started_at, p_ended_at, p_run_type,
      p_distance_m, p_duration_s, p_avg_pace_s_per_km,
      p_avg_heart_rate, p_max_heart_rate, p_avg_cadence,
      p_elevation_gain_m, p_elevation_loss_m, p_calories,
      p_perceived_effort, p_notes, active_meso_id
    )
    RETURNING id INTO session_id;
    is_new := true;
  END IF;

  -- Insert laps
  IF p_laps IS NOT NULL THEN
    FOR lap IN SELECT * FROM jsonb_array_elements(p_laps)
    LOOP
      INSERT INTO run_laps (
        run_session_id, lap_number, distance_m, duration_s,
        avg_pace_s_per_km, avg_heart_rate, max_heart_rate,
        avg_cadence, elevation_gain_m
      ) VALUES (
        session_id,
        (lap->>'lap_number')::integer,
        (lap->>'distance_m')::numeric,
        (lap->>'duration_s')::numeric,
        (lap->>'avg_pace_s_per_km')::numeric,
        (lap->>'avg_heart_rate')::integer,
        (lap->>'max_heart_rate')::integer,
        (lap->>'avg_cadence')::integer,
        (lap->>'elevation_gain_m')::numeric
      );
    END LOOP;
  END IF;

  -- Insert HR zones
  IF p_hr_zones IS NOT NULL THEN
    FOR zone IN SELECT * FROM jsonb_array_elements(p_hr_zones)
    LOOP
      INSERT INTO run_hr_zones (
        run_session_id, zone_number, duration_s, min_hr, max_hr
      ) VALUES (
        session_id,
        (zone->>'zone_number')::integer,
        (zone->>'duration_s')::numeric,
        (zone->>'min_hr')::integer,
        (zone->>'max_hr')::integer
      );
    END LOOP;
  END IF;

  RETURN json_build_object(
    'run_session_id', session_id,
    'is_new', is_new,
    'external_id', p_external_id
  );
END;
$$;
```

### 2.20 `delete_run_session_by_external_id`

```sql
CREATE OR REPLACE FUNCTION delete_run_session_by_external_id(
  p_external_id text,
  p_source text DEFAULT 'strava'
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_id uuid;
BEGIN
  DELETE FROM run_sessions
  WHERE external_id = p_external_id AND source = p_source
  RETURNING id INTO deleted_id;

  -- Laps and HR zones cascade-delete automatically

  RETURN json_build_object(
    'deleted', deleted_id IS NOT NULL,
    'run_session_id', deleted_id
  );
END;
$$;
```

### 2.21 `get_strava_tokens`

```sql
CREATE OR REPLACE FUNCTION get_strava_tokens()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result json;
BEGIN
  SELECT json_build_object(
    'athlete_id', athlete_id,
    'access_token', access_token,
    'refresh_token', refresh_token,
    'expires_at', expires_at,
    'scope', scope
  ) INTO result
  FROM strava_tokens
  LIMIT 1;

  RETURN result;  -- NULL if no tokens stored
END;
$$;
```

### 2.22 `save_strava_tokens`

```sql
CREATE OR REPLACE FUNCTION save_strava_tokens(
  p_athlete_id bigint,
  p_access_token text,
  p_refresh_token text,
  p_expires_at bigint,
  p_scope text DEFAULT NULL,
  p_athlete_json jsonb DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO strava_tokens (athlete_id, access_token, refresh_token, expires_at, scope, athlete_json)
  VALUES (p_athlete_id, p_access_token, p_refresh_token, p_expires_at, p_scope, p_athlete_json)
  ON CONFLICT (athlete_id) DO UPDATE SET
    access_token = EXCLUDED.access_token,
    refresh_token = EXCLUDED.refresh_token,
    expires_at = EXCLUDED.expires_at,
    scope = COALESCE(EXCLUDED.scope, strava_tokens.scope),
    athlete_json = COALESCE(EXCLUDED.athlete_json, strava_tokens.athlete_json),
    updated_at = now();

  RETURN json_build_object('athlete_id', p_athlete_id, 'saved', true);
END;
$$;
```

---

## 3. MCP Tool Definitions

Each tool maps 1:1 to an RPC function. The MCP server is a thin dispatch layer.

### 3.1 `get_active_mesocycle`

```
Name:        get_active_mesocycle
Description: Get the currently active mesocycle with its training days.
             USE WHEN: Starting a conversation, needing current training context, or user asks about their current block.

Input Schema: {} (no parameters)

Output: JSON object with id, name, focus, start_date, end_date, status, notes, days[]
```

### 3.2 `get_workout_plan`

```
Name:        get_workout_plan
Description: Get the planned exercises for a specific training day and week.
             USE WHEN: User is about to start a workout, asks "what's the plan today", or needs to see targets.

Input Schema:
  mesocycle_id:   string (uuid, required)  - The mesocycle ID
  day_id:         string (uuid, required)  - The mesocycle_day ID
  week_number:    number (integer, required) - Week number in the mesocycle

Output: JSON array of exercise objects with target_sets, target_reps, target_weight_kg, superset_group, notes
```

### 3.3 `start_workout`

```
Name:        start_workout
Description: Create a new workout record and return the workout ID. Call this when a session begins.
             USE WHEN: User says they're at the gym, starting a workout, or sends readiness data.

Input Schema:
  mesocycle_id:      string (uuid, required)
  mesocycle_day_id:  string (uuid, required)
  week_number:       number (integer, required)
  date:              string (YYYY-MM-DD, optional, default: today)
  sleep_quality:     number (1-5, optional)
  energy_level:      number (1-5, optional)
  muscle_soreness:   object (jsonb, optional) - e.g. {"back": 2, "chest": 1}
  pre_session_notes: string (optional)

Output: { "workout_id": "uuid" }
```

### 3.4 `log_sets`

```
Name:        log_sets
Description: Log one or more sets for an exercise in the current workout. Accepts multiple sets at once.
             USE WHEN: User reports completing sets — e.g. "80kg x 8, 8, 7" or "did 3 sets of 12 at 60".

Input Schema:
  workout_id:  string (uuid, required)
  exercise_id: string (uuid, required)
  sets:        array (required) - Each element:
    weight_kg: number (optional)
    reps:      number (integer, required)
    rpe:       number (optional)
    set_type:  string (optional) - "working", "warmup", "drop", "failure", "rest_pause", "myo"
    notes:     string (optional)

Output: { "logged": 3, "exercise_id": "uuid", "workout_id": "uuid" }
```

### 3.5 `log_exercise_feedback`

```
Name:        log_exercise_feedback
Description: Record pump quality and joint discomfort feedback for an exercise after completing it.
             USE WHEN: User provides pump/joint feedback after finishing an exercise.

Input Schema:
  workout_id:       string (uuid, required)
  exercise_id:      string (uuid, required)
  pump_quality:     number (1-5, optional)
  joint_discomfort: number (0-3, optional)
  notes:            string (optional)

Output: { "id": "uuid" }
```

### 3.6 `end_workout`

```
Name:        end_workout
Description: Mark a workout as completed, recording end time and optional rating/notes.
             USE WHEN: User says "done", "finished", or the session is wrapping up.

Input Schema:
  workout_id: string (uuid, required)
  rating:     number (1-5, optional)
  notes:      string (optional)

Output: { "workout_id": "uuid", "started_at": "timestamp", "ended_at": "timestamp", "duration_min": 48.5 }
```

### 3.7 `get_workout_review`

```
Name:        get_workout_review
Description: Get full details of a completed workout including all sets, exercise feedback, and metadata.
             USE WHEN: User asks to review a session, compare actual vs planned, or asks "how did that go?"

Input Schema:
  workout_id: string (uuid, required)

Output: { workout: {...}, sets: [...], feedback: [...] }
```

### 3.8 `get_week_summary`

```
Name:        get_week_summary
Description: Get all workouts, sets, feedback, and targets for a given week in a mesocycle.
             USE WHEN: User asks about their week, wants a weekly review, or asks to generate next week.

Input Schema:
  mesocycle_id: string (uuid, required)
  week_number:  number (integer, required)

Output: { mesocycle_id, week_number, workouts: [...], targets: [...] }
```

### 3.9 `save_weekly_targets`

```
Name:        save_weekly_targets
Description: Save or replace all weekly targets for a given week. Replaces all existing targets for that week.
             USE WHEN: After weekly review, user confirms next week's plan, or progression changes are agreed.

Input Schema:
  mesocycle_id: string (uuid, required)
  week_number:  number (integer, required)
  targets:      array (required) - Each element:
    mesocycle_day_id: string (uuid, required)
    exercise_id:     string (uuid, required)
    exercise_order:  number (integer, required)
    target_sets:     number (integer, required)
    target_reps:     string (required) - e.g. "8-10" or "12"
    target_weight_kg: number (optional)
    superset_group:  string (optional) - e.g. "A", "B1"
    notes:           string (optional)

Output: { "saved": 14, "week": 3 }
```

### 3.10 `get_exercise_history`

```
Name:        get_exercise_history
Description: Get performance history for a specific exercise (max weight, reps over time).
             USE WHEN: User asks about exercise progression, wants to see trends, or is reviewing performance.

Input Schema:
  exercise_id: string (uuid, required)
  limit:       number (integer, optional, default: 20)

Output: JSON array of { date, week_number, mesocycle_name, max_weight_kg, reps_at_max_weight }
```

### 3.11 `get_volume_summary`

```
Name:        get_volume_summary
Description: Get weekly training volume (sets and tonnage) by muscle group.
             USE WHEN: User asks about volume, wants to check if a muscle group has enough work, or reviewing load.

Input Schema:
  mesocycle_id: string (uuid, optional, default: active mesocycle)
  weeks:        number (integer, optional, default: 4)

Output: JSON array of { week_number, muscle_group, total_sets, total_volume_kg }
```

### 3.12 `get_goals`

```
Name:        get_goals
Description: Get training goals with current progress data.
             USE WHEN: User asks about goals, wants to check progress, or mentions a target.

Input Schema:
  status: string (optional, default: "active") - "active", "achieved", or "all"

Output: JSON array of goal objects with current_best data
```

### 3.13 `upsert_goal`

```
Name:        upsert_goal
Description: Create or update a training goal.
             USE WHEN: User sets a new goal, adjusts a target, or wants to track a milestone.

Input Schema:
  exercise_id:  string (uuid, required)
  goal_type:    string (required) - "weight", "reps", "time"
  target_value: number (required) - Target weight in kg, target reps count, or target time in seconds
  target_reps:  number (integer, optional) - For weight goals: reps at that weight
  target_date:  string (YYYY-MM-DD, optional)
  mesocycle_id: string (uuid, optional)
  notes:        string (optional)
  id:           string (uuid, optional) - Pass existing goal ID to update

Output: { "goal_id": "uuid" }
```

### 3.14 `mark_goal_achieved`

```
Name:        mark_goal_achieved
Description: Mark a goal as achieved with the current timestamp.
             USE WHEN: User hits a goal target, or explicitly says they achieved a goal.

Input Schema:
  goal_id: string (uuid, required)

Output: { "goal_id": "uuid", "achieved_at": "timestamp" }
```

### 3.15 `search_exercises`

```
Name:        search_exercises
Description: Search the exercise library by name, muscle group, or equipment.
             USE WHEN: Looking up an exercise ID, browsing available exercises, or finding alternatives.

Input Schema:
  query:        string (optional) - Partial name match
  muscle_group: string (optional) - e.g. "chest", "back", "legs"
  equipment:    string (optional) - e.g. "dumbbell", "cable", "barbell"

Output: JSON array of exercise objects
```

### 3.16 `create_mesocycle`

```
Name:        create_mesocycle
Description: Create a new mesocycle and mark it as active (deactivates any current active mesocycle).
             USE WHEN: User wants to start a new training block.

Input Schema:
  name:       string (required)
  focus:      string (required) - e.g. "hypertrophy", "strength", "Strength + Endurance"
  start_date: string (YYYY-MM-DD, required)
  end_date:   string (YYYY-MM-DD, optional)
  notes:      string (optional)
  days:       array (optional) - Each element: { day_number, name, notes }

Output: { "mesocycle_id": "uuid" }
```

### 3.17 `get_run_sessions`

```
Name:        get_run_sessions
Description: Get recent run sessions with summary metrics.
             USE WHEN: User asks about their runs, running history, or wants to see recent sessions.

Input Schema:
  limit:     number (integer, optional, default: 10)
  run_type:  string (optional) - "easy", "tempo", "interval", "long", "race", "fartlek"
  date_from: string (YYYY-MM-DD, optional)
  date_to:   string (YYYY-MM-DD, optional)

Output: JSON array of run session summaries
```

### 3.18 `get_run_detail`

```
Name:        get_run_detail
Description: Get full detail of a run session including lap splits and heart rate zones.
             USE WHEN: User asks about a specific run, wants to see splits, or needs HR data.

Input Schema:
  run_session_id: string (uuid, required)

Output: { session: {...}, laps: [...], hr_zones: [...] }
```

---

## 4. Edge Function: `mcp-server`

### 4.1 File Structure

```
supabase/functions/mcp-server/
  index.ts      -- Main entry point
  deno.json     -- Dependencies
```

### 4.2 `deno.json`

```json
{
  "compilerOptions": {
    "lib": ["deno.window", "deno.ns"],
    "strict": true
  },
  "imports": {
    "hono": "npm:hono@^4.6.14",
    "mcp-lite": "npm:mcp-lite@0.8.2",
    "zod": "npm:zod@^3.23.8",
    "@supabase/supabase-js": "npm:@supabase/supabase-js@^2.45.0"
  }
}
```

### 4.3 `index.ts` -- Architecture

The structure follows the ACC template exactly. Key differences from the ACC server:

1. **No OAuth/JWT auth** -- This is a single-user personal app. Auth is via a shared secret in the `Authorization` header (`Bearer <MCP_SECRET>`).
2. **No `asyncLocalStorage` needed** -- Single user, no per-request identity.
3. **Simpler routing** -- Just `/mcp` POST endpoint plus health check.

```typescript
/**
 * Workout Tracker - MCP Server
 *
 * Single-user MCP server for Claude.ai project integration.
 * All queries go through SECURITY DEFINER RPC functions.
 * Auth: shared secret in Authorization header.
 */

import { Hono } from 'hono'
import { McpServer, StreamableHttpTransport } from 'mcp-lite'
import { z } from 'zod'
import { createClient } from '@supabase/supabase-js'

// =============================================================================
// CONFIGURATION
// =============================================================================

const SUPABASE_URL = 'https://xwfshemzhunaxbzjgata.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
if (!SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('FATAL: SUPABASE_SERVICE_ROLE_KEY not set')
}

const MCP_SECRET = Deno.env.get('MCP_SECRET')
if (!MCP_SECRET) {
  throw new Error('FATAL: MCP_SECRET not set')
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// =============================================================================
// AUTH - Simple shared secret
// =============================================================================

function verifyAuth(authHeader: string | null): boolean {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false
  return authHeader.slice(7) === MCP_SECRET
}

// =============================================================================
// HELPERS
// =============================================================================

function formatResult(data: unknown) {
  return {
    content: [{
      type: 'text' as const,
      text: typeof data === 'string' ? data : JSON.stringify(data, null, 2)
    }]
  }
}

// Zod to JSON Schema converter (identical to ACC template)
function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // ... (copy from ACC template, lines 243-277)
}

// =============================================================================
// MCP SERVER + TOOLS
// =============================================================================

const mcp = new McpServer({
  name: 'workout-tracker',
  version: '1.0.0',
  schemaAdapter: (schema) => {
    if (schema && typeof schema === 'object' && '_def' in schema) {
      return zodToJsonSchema(schema as z.ZodType)
    }
    return schema
  },
})

// --- Tool registrations follow the pattern: ---
// mcp.tool('name', {
//   description: '...',
//   inputSchema: z.object({...}),
//   handler: async (args) => {
//     const { data, error } = await supabase.rpc('rpc_name', { params })
//     if (error) throw new Error(`rpc_name failed: ${error.message}`)
//     return formatResult(data)
//   },
// })

// Register all 18 tools from Section 3 above.
// Each tool handler is 5-10 lines: map args to RPC params, call supabase.rpc(), return formatResult().

// Example: get_active_mesocycle
mcp.tool('get_active_mesocycle', {
  description: `Get the currently active mesocycle with its training days.
USE WHEN: Starting a conversation, needing current training context, or user asks about their current block.`,
  inputSchema: z.object({}),
  handler: async () => {
    const { data, error } = await supabase.rpc('get_active_mesocycle')
    if (error) throw new Error(`get_active_mesocycle failed: ${error.message}`)
    return formatResult(data)
  },
})

// Example: log_sets
mcp.tool('log_sets', {
  description: `Log one or more sets for an exercise in the current workout.
USE WHEN: User reports completing sets — e.g. "80kg x 8, 8, 7" or "did 3 sets of 12 at 60".`,
  inputSchema: z.object({
    workout_id: z.string().describe('The active workout ID'),
    exercise_id: z.string().describe('The exercise ID'),
    sets: z.array(z.object({
      weight_kg: z.number().optional().describe('Weight in kg'),
      reps: z.number().describe('Number of reps'),
      rpe: z.number().optional().describe('RPE rating'),
      set_type: z.string().optional().describe('working, warmup, drop, failure, rest_pause, myo'),
      notes: z.string().optional(),
    })).describe('Array of sets to log'),
  }),
  handler: async (args) => {
    const { data, error } = await supabase.rpc('log_sets', {
      p_workout_id: args.workout_id,
      p_exercise_id: args.exercise_id,
      p_sets: args.sets,
    })
    if (error) throw new Error(`log_sets failed: ${error.message}`)
    return formatResult(data)
  },
})

// ... (register all remaining tools following the same pattern)

// =============================================================================
// HTTP SERVER
// =============================================================================

const transport = new StreamableHttpTransport()
const httpHandler = transport.bind(mcp)

const app = new Hono()

// CORS
app.options('*', (c) => new Response(null, {
  status: 204,
  headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  },
}))

app.use('*', async (c, next) => {
  await next()
  c.header('Access-Control-Allow-Origin', '*')
})

// Health check
app.get('/mcp-server', (c) => c.json({
  name: 'Workout Tracker MCP Server',
  version: '1.0.0',
  status: 'healthy',
}))

app.get('/mcp-server/health', (c) => c.json({ status: 'ok' }))

// MCP endpoint
app.post('/mcp-server/mcp', async (c) => {
  // Auth check
  if (!verifyAuth(c.req.header('authorization'))) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  const body = await c.req.text()
  const newReq = new Request(c.req.raw.url, {
    method: 'POST',
    headers: c.req.raw.headers,
    body: body,
  })

  try {
    const response = await httpHandler(newReq)
    // Return as-is (Claude.ai uses JSON, not SSE)
    return response
  } catch (error) {
    console.error('MCP handler error:', error)
    return c.json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: error instanceof Error ? error.message : 'Unknown error' }
    })
  }
})

Deno.serve(app.fetch)
```

### 4.4 Auth Mechanism

- **Secret:** A random string stored as Supabase edge function secret `MCP_SECRET`.
- **Header:** `Authorization: Bearer <MCP_SECRET>`.
- **Where it's configured:** In Claude.ai project settings, when adding the MCP server URL, the auth token field is set to this secret.
- **Set the secret:** `supabase secrets set MCP_SECRET=<random-64-char-string> --project-ref xwfshemzhunaxbzjgata`

### 4.5 Deployment

```bash
supabase functions deploy mcp-server --no-verify-jwt --project-ref xwfshemzhunaxbzjgata
```

The `--no-verify-jwt` flag is required because we use our own auth (shared secret), not Supabase JWT auth.

---

## 5. Edge Function: `strava-webhook`

### 5.1 Purpose

Receives webhook events from Strava when activities are created, updated, or deleted. For `Run` activities, it fetches the full activity data from Strava API and syncs it to `run_sessions`.

### 5.2 File Structure

```
supabase/functions/strava-webhook/
  index.ts
  deno.json     -- same as mcp-server
```

### 5.3 `deno.json`

```json
{
  "compilerOptions": {
    "lib": ["deno.window", "deno.ns"],
    "strict": true
  },
  "imports": {
    "hono": "npm:hono@^4.6.14",
    "@supabase/supabase-js": "npm:@supabase/supabase-js@^2.45.0"
  }
}
```

### 5.4 `index.ts` -- Full Logic

```typescript
import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://xwfshemzhunaxbzjgata.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const STRAVA_CLIENT_ID = Deno.env.get('STRAVA_CLIENT_ID')!
const STRAVA_CLIENT_SECRET = Deno.env.get('STRAVA_CLIENT_SECRET')!
const STRAVA_VERIFY_TOKEN = Deno.env.get('STRAVA_VERIFY_TOKEN')!

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// =============================================================================
// STRAVA API HELPERS
// =============================================================================

/** Refresh access token if expired, return valid access_token */
async function getValidAccessToken(): Promise<string> {
  const { data: tokens } = await supabase.rpc('get_strava_tokens')
  if (!tokens) throw new Error('No Strava tokens found. Complete OAuth first.')

  const now = Math.floor(Date.now() / 1000)

  // If token expires in more than 5 minutes, use it
  if (tokens.expires_at > now + 300) {
    return tokens.access_token
  }

  // Refresh the token
  console.log('[strava] Refreshing access token...')
  const resp = await fetch('https://www.strava.com/api/v3/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: parseInt(STRAVA_CLIENT_ID),
      client_secret: STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    }),
  })

  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`Token refresh failed: ${resp.status} ${errText}`)
  }

  const refreshed = await resp.json()
  // Response: { token_type, access_token, refresh_token, expires_at, expires_in }

  // Save new tokens
  await supabase.rpc('save_strava_tokens', {
    p_athlete_id: tokens.athlete_id,
    p_access_token: refreshed.access_token,
    p_refresh_token: refreshed.refresh_token,
    p_expires_at: refreshed.expires_at,
  })

  return refreshed.access_token
}

/** Fetch full activity from Strava API */
async function fetchStravaActivity(activityId: number, accessToken: string) {
  const resp = await fetch(
    `https://www.strava.com/api/v3/activities/${activityId}?include_all_efforts=false`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`Strava API error ${resp.status}: ${errText}`)
  }
  return await resp.json()
}

/** Fetch laps for an activity */
async function fetchStravaLaps(activityId: number, accessToken: string) {
  const resp = await fetch(
    `https://www.strava.com/api/v3/activities/${activityId}/laps`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  if (!resp.ok) return []
  return await resp.json()
}

/** Fetch heart rate zones for an activity */
async function fetchStravaZones(activityId: number, accessToken: string) {
  const resp = await fetch(
    `https://www.strava.com/api/v3/activities/${activityId}/zones`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  if (!resp.ok) return []
  return await resp.json()
}

// =============================================================================
// STRAVA -> DATABASE FIELD MAPPING
// =============================================================================

/**
 * Map Strava sport_type to our run_type enum.
 * Strava sport_type values for running: Run, TrailRun, VirtualRun
 * We map to: easy (default), with user able to reclassify later.
 */
function mapRunType(activity: any): string | null {
  // Strava doesn't distinguish tempo/interval/etc in sport_type.
  // We use 'easy' as default; user can update via MCP.
  // If activity.workout_type is set: 0=default, 1=race, 2=long_run, 3=workout (interval/tempo)
  const workoutType = activity.workout_type
  if (workoutType === 1) return 'race'
  if (workoutType === 2) return 'long'
  if (workoutType === 3) return 'tempo'  // "workout" in Strava = structured session
  return 'easy'
}

/** Check if a Strava activity is a run */
function isRunActivity(activity: any): boolean {
  const runTypes = ['Run', 'TrailRun', 'VirtualRun']
  return runTypes.includes(activity.sport_type) || runTypes.includes(activity.type)
}

/** Map Strava activity to our upsert_run_session params */
function mapActivityToRunSession(activity: any) {
  const startDate = new Date(activity.start_date_local || activity.start_date)

  return {
    p_external_id: String(activity.id),
    p_source: 'strava',
    p_date: startDate.toISOString().split('T')[0],
    p_started_at: activity.start_date,  // ISO 8601 UTC
    p_ended_at: activity.start_date
      ? new Date(new Date(activity.start_date).getTime() + (activity.elapsed_time * 1000)).toISOString()
      : null,
    p_run_type: mapRunType(activity),
    p_distance_m: activity.distance,                     // Strava: meters (float)
    p_duration_s: activity.moving_time,                   // Strava: seconds (int)
    p_avg_pace_s_per_km: activity.distance > 0
      ? Math.round((activity.moving_time / (activity.distance / 1000)))
      : null,
    p_avg_heart_rate: activity.average_heartrate ? Math.round(activity.average_heartrate) : null,
    p_max_heart_rate: activity.max_heartrate ? Math.round(activity.max_heartrate) : null,
    p_avg_cadence: activity.average_cadence ? Math.round(activity.average_cadence * 2) : null,
    // Note: Strava cadence is steps per minute for one foot; multiply by 2 for total
    p_elevation_gain_m: activity.total_elevation_gain,
    p_elevation_loss_m: activity.elev_low != null && activity.elev_high != null
      ? null  // Strava doesn't provide elevation loss directly; leave null
      : null,
    p_calories: activity.calories ? Math.round(activity.calories) : null,
    p_perceived_effort: activity.perceived_exertion
      ? Math.round(activity.perceived_exertion)
      : null,
    p_notes: activity.description || null,
  }
}

/** Map Strava laps to our run_laps format */
function mapLaps(stravaLaps: any[]): any[] {
  return stravaLaps.map((lap, idx) => ({
    lap_number: idx + 1,
    distance_m: lap.distance,
    duration_s: lap.moving_time,
    avg_pace_s_per_km: lap.distance > 0
      ? Math.round(lap.moving_time / (lap.distance / 1000))
      : null,
    avg_heart_rate: lap.average_heartrate ? Math.round(lap.average_heartrate) : null,
    max_heart_rate: lap.max_heartrate ? Math.round(lap.max_heartrate) : null,
    avg_cadence: lap.average_cadence ? Math.round(lap.average_cadence * 2) : null,
    elevation_gain_m: lap.total_elevation_gain,
  }))
}

/** Map Strava zones to our run_hr_zones format */
function mapHrZones(stravaZones: any[]): any[] {
  // Strava returns array of ActivityZone objects; find the one with type "heartrate"
  const hrZone = stravaZones.find((z: any) => z.type === 'heartrate')
  if (!hrZone || !hrZone.distribution_buckets) return []

  return hrZone.distribution_buckets.map((bucket: any, idx: number) => ({
    zone_number: idx + 1,
    duration_s: bucket.time,
    min_hr: bucket.min,
    max_hr: bucket.max,
  }))
}

// =============================================================================
// WEBHOOK HANDLERS
// =============================================================================

async function handleActivityCreate(activityId: number) {
  const accessToken = await getValidAccessToken()
  const activity = await fetchStravaActivity(activityId, accessToken)

  if (!isRunActivity(activity)) {
    console.log(`[strava] Activity ${activityId} is ${activity.sport_type}, skipping (not a run)`)
    return { status: 'skipped', reason: `Not a run: ${activity.sport_type}` }
  }

  // Fetch laps and zones in parallel
  const [stravaLaps, stravaZones] = await Promise.all([
    fetchStravaLaps(activityId, accessToken),
    fetchStravaZones(activityId, accessToken),
  ])

  const sessionParams = mapActivityToRunSession(activity)
  const laps = mapLaps(stravaLaps)
  const hrZones = mapHrZones(stravaZones)

  const { data, error } = await supabase.rpc('upsert_run_session', {
    ...sessionParams,
    p_laps: laps.length > 0 ? laps : null,
    p_hr_zones: hrZones.length > 0 ? hrZones : null,
  })

  if (error) throw new Error(`upsert_run_session failed: ${error.message}`)

  // Log sync
  await supabase.from('strava_sync_log').insert({
    strava_activity_id: activityId,
    event_type: 'create',
    status: 'success',
    run_session_id: data.run_session_id,
    raw_payload: { sport_type: activity.sport_type, distance: activity.distance },
  })

  return data
}

async function handleActivityUpdate(activityId: number) {
  // Same as create -- upsert_run_session handles update logic
  return await handleActivityCreate(activityId)
}

async function handleActivityDelete(activityId: number) {
  const { data, error } = await supabase.rpc('delete_run_session_by_external_id', {
    p_external_id: String(activityId),
    p_source: 'strava',
  })

  if (error) throw new Error(`delete_run_session failed: ${error.message}`)

  await supabase.from('strava_sync_log').insert({
    strava_activity_id: activityId,
    event_type: 'delete',
    status: data.deleted ? 'success' : 'skipped',
  })

  return data
}

// =============================================================================
// HTTP SERVER
// =============================================================================

const app = new Hono()

// Webhook validation (GET) -- Strava sends this when creating a subscription
app.get('/strava-webhook', (c) => {
  const mode = c.req.query('hub.mode')
  const token = c.req.query('hub.verify_token')
  const challenge = c.req.query('hub.challenge')

  console.log(`[strava-webhook] Validation: mode=${mode}, token=${token}`)

  if (mode === 'subscribe' && token === STRAVA_VERIFY_TOKEN) {
    console.log('[strava-webhook] Validation successful')
    return c.json({ 'hub.challenge': challenge })
  }

  return c.json({ error: 'Invalid verify token' }, 403)
})

// Webhook event (POST) -- Strava pushes events here
app.post('/strava-webhook', async (c) => {
  const event = await c.req.json()
  console.log(`[strava-webhook] Event: ${JSON.stringify(event)}`)

  // Event shape: { aspect_type, event_time, object_id, object_type, owner_id, subscription_id, updates }

  // Must respond 200 within 2 seconds -- process async
  // For Deno edge functions, we process synchronously but keep it fast
  // The Strava API calls will add latency, so we use waitUntil if available

  if (event.object_type !== 'activity') {
    console.log(`[strava-webhook] Ignoring non-activity event: ${event.object_type}`)
    return c.json({ status: 'ignored' })
  }

  const activityId = event.object_id as number

  try {
    let result

    switch (event.aspect_type) {
      case 'create':
        result = await handleActivityCreate(activityId)
        break
      case 'update':
        result = await handleActivityUpdate(activityId)
        break
      case 'delete':
        result = await handleActivityDelete(activityId)
        break
      default:
        console.log(`[strava-webhook] Unknown aspect_type: ${event.aspect_type}`)
        return c.json({ status: 'unknown_event' })
    }

    console.log(`[strava-webhook] Processed: ${JSON.stringify(result)}`)
    return c.json({ status: 'ok' })
  } catch (err) {
    console.error(`[strava-webhook] Error processing activity ${activityId}:`, err)

    // Log the error
    await supabase.from('strava_sync_log').insert({
      strava_activity_id: activityId,
      event_type: event.aspect_type,
      status: 'error',
      error_message: err instanceof Error ? err.message : 'Unknown error',
      raw_payload: event,
    }).catch(() => {})  // Don't let logging failure crash the handler

    // Still return 200 to prevent Strava retries for known errors
    return c.json({ status: 'error' })
  }
})

Deno.serve(app.fetch)
```

### 5.5 Error Handling Matrix

| Failure | Response | Behavior |
|---------|----------|----------|
| Invalid verify_token on GET | 403 | Strava subscription creation fails |
| Non-activity event | 200 + `{ status: "ignored" }` | No processing |
| Non-run activity (cycling, etc.) | 200 + `{ status: "skipped" }` | Logged to sync_log |
| Token refresh fails | 200 + error logged | Logged to sync_log, Strava won't retry |
| Strava API 404 (activity deleted before fetch) | 200 + error logged | Logged, no DB change |
| Strava API 429 (rate limit) | 200 + error logged | Logged; manual retry needed |
| DB insert/update fails | 200 + error logged | Logged to sync_log |
| Handler exceeds 2s | Strava retries (up to 3x) | Edge function timeout is 60s, so this shouldn't happen |

### 5.6 Deployment

```bash
supabase secrets set STRAVA_CLIENT_ID=<id> STRAVA_CLIENT_SECRET=<secret> STRAVA_VERIFY_TOKEN=<random-string> --project-ref xwfshemzhunaxbzjgata
supabase functions deploy strava-webhook --no-verify-jwt --project-ref xwfshemzhunaxbzjgata
```

### 5.7 Strava Field-by-Field Mapping Reference

| Strava Field | Type | Our Field | Transform |
|---|---|---|---|
| `id` | long | `external_id` | `String(id)` |
| `sport_type` | string | -- | Used to filter: only `Run`, `TrailRun`, `VirtualRun` |
| `workout_type` | int | `run_type` | 0=easy, 1=race, 2=long, 3=tempo |
| `start_date` | ISO8601 | `started_at` | Direct |
| `start_date_local` | ISO8601 | `date` | `.split('T')[0]` |
| `distance` | float (meters) | `distance_m` | Direct |
| `moving_time` | int (seconds) | `duration_s` | Direct |
| `elapsed_time` | int (seconds) | `ended_at` | `start_date + elapsed_time` |
| -- (computed) | -- | `avg_pace_s_per_km` | `moving_time / (distance / 1000)` |
| `average_heartrate` | float | `avg_heart_rate` | `Math.round()` |
| `max_heartrate` | float | `max_heart_rate` | `Math.round()` |
| `average_cadence` | float | `avg_cadence` | `Math.round(value * 2)` (Strava = single-foot) |
| `total_elevation_gain` | float (meters) | `elevation_gain_m` | Direct |
| `calories` | float | `calories` | `Math.round()` |
| `perceived_exertion` | int (1-10) | `perceived_effort` | Direct |
| `description` | string | `notes` | Direct |

**Lap Mapping:**

| Strava Lap Field | Our Field | Transform |
|---|---|---|
| array index | `lap_number` | `idx + 1` |
| `distance` | `distance_m` | Direct |
| `moving_time` | `duration_s` | Direct |
| computed | `avg_pace_s_per_km` | `moving_time / (distance / 1000)` |
| `average_heartrate` | `avg_heart_rate` | `Math.round()` |
| `max_heartrate` | `max_heart_rate` | `Math.round()` |
| `average_cadence` | `avg_cadence` | `Math.round(value * 2)` |
| `total_elevation_gain` | `elevation_gain_m` | Direct |

**HR Zone Mapping:**

| Strava Zone Field | Our Field | Transform |
|---|---|---|
| array index (from distribution_buckets) | `zone_number` | `idx + 1` |
| `time` | `duration_s` | Direct |
| `min` | `min_hr` | Direct |
| `max` | `max_hr` | Direct |

---

## 6. Strava Token Seeding (replaces strava-auth edge function)

### 6.1 Why No Auth Edge Function

User already has tokens from the Strava API app settings page. Instead of building a full OAuth edge function, we seed the tokens directly into the database and rely on the webhook edge function's built-in token refresh logic.

### 6.2 Strava Credentials

- **Client ID:** `206698`
- **Client Secret:** `14e52a80493f635d5d40bbcaab6bc8624e738112`
- **Access Token:** `375ea397f2f3ef5f6eff576c0e973fd38de6c11e`
- **Refresh Token:** `16b73ec72d1f18eb23afba38ab4e84a4d793c1ad`

### 6.3 Seed Tokens via RPC

```sql
SELECT save_strava_tokens(
  p_athlete_id := 0,  -- placeholder, updated on first webhook activity
  p_access_token := '375ea397f2f3ef5f6eff576c0e973fd38de6c11e',
  p_refresh_token := '16b73ec72d1f18eb23afba38ab4e84a4d793c1ad',
  p_expires_at := 0,  -- force refresh on first use
  p_scope := 'activity:read_all',
  p_athlete_json := '{}'::jsonb
);
```

Setting `expires_at := 0` ensures the webhook function will refresh the token on first use, which also retrieves the correct `athlete_id`.

### 6.4 Set Supabase Secrets

```bash
supabase secrets set STRAVA_CLIENT_ID=206698 STRAVA_CLIENT_SECRET=14e52a80493f635d5d40bbcaab6bc8624e738112 --project-ref xwfshemzhunaxbzjgata
```

### 6.5 Creating the Webhook Subscription (one-time, after strava-webhook is deployed)

```bash
curl -X POST https://www.strava.com/api/v3/push_subscriptions \
  -F client_id=206698 \
  -F client_secret=14e52a80493f635d5d40bbcaab6bc8624e738112 \
  -F callback_url=https://xwfshemzhunaxbzjgata.supabase.co/functions/v1/strava-webhook \
  -F verify_token=<STRAVA_VERIFY_TOKEN>
```

This triggers the GET validation on the webhook endpoint. If it returns the challenge correctly, Strava creates the subscription and returns `{ "id": <subscription_id> }`.

Save the subscription ID to the `strava_webhook_subscriptions` table for reference.

---

## 7. Claude.ai Project Instructions

The following is the complete draft of the Claude.ai custom project instructions. This text goes into the Claude.ai project settings "Custom instructions" field.

---

**BEGIN INSTRUCTIONS**

You are Harry's training partner and workout coach. You have access to his training database via MCP tools. You track gym sessions, running data, mesocycle planning, and goals.

## User Profile

- Male, 92kg, 6'2" (188cm)
- Prefers dumbbells over barbell on some pressing movements (comfort preference, not injury)
- No squats or conventional deadlifts (lower back issues)
- Uses straps for heavy pulling (grip is limiting)
- Tracks weights in kg
- Current block: Hybrid Block 1 (3 gym days + 3 run days)
- Goals: Bench Press 120kg, Pull Up 17 reps bodyweight, 5K sub-23:00

## Core Behavior

- Be a knowledgeable, casual training partner -- not a formal assistant
- Match response length to the question. Short questions get short answers
- Don't over-explain things Harry already knows
- When Harry mentions training data, pull the actual numbers -- don't guess
- Store data immediately when it's reported. Never ask "want me to save this?"
- Ask when genuinely unsure. Don't assume

## Mode Detection

Detect what mode Harry is in based on context:

**Session Mode** -- "at the gym", "starting [day name]", "doing pull push", sends set data
**Post-Session** -- "how'd that go?", "review my workout", asking about a completed workout
**Weekly Planning** -- "what's the plan this week?", "review last week", "generate next week"
**Meso Planning** -- "new block", "design a mesocycle", "adjust the program"
**Goal Setting** -- "I want to hit X", "how am I tracking?", "set a goal"
**General** -- everything else, casual chat, general training questions

## Session Mode

When Harry starts a workout:

1. Ask readiness check: `Sleep / Energy / [muscles for today] soreness:` (scales: Sleep/Energy 1-5, Soreness 1-5)
2. Accept numeric (e.g. `4 3 2 1`) or verbal responses. Parse what you can.
3. Call `start_workout` with the readiness data
4. Call `get_workout_plan` and display the plan grouped by supersets (A1/A2, B1/B2 etc)
5. Format: `Exercise -- sets x reps @ weight (RPE if set)`

When Harry reports sets:
- Parse natural language: "80kg x 8", "did 8 at 80", "same as last set", "3 sets of 12"
- Call `log_sets` immediately
- Confirm briefly: `Logged: Bench 80kg x 8, 8, 7`
- After each exercise, prompt: `Pump / Joint:` (Pump 1-5, Joint 0-3)
- Accept numeric (`4 0`) or verbal. Default to pump=3, joint=0 if skipped
- Call `log_exercise_feedback`

Set types to recognize: warmup, drop set, failure, rest-pause, myo reps. Log the set_type automatically.

If Harry mentions something noteworthy (felt easy, grip failed, shoulder tweaked), store it as a note on the set or exercise immediately.

When session ends:
- Call `end_workout`
- Show duration and total sets
- Prompt for rating (1-5) -- don't force

Keep responses to 1-3 lines during sessions. No essays. No "Great job!" after every set.

## Post-Session Mode

When reviewing a workout:
- Call `get_workout_review` for the session
- Call `get_workout_plan` for the planned targets
- Compare actual vs planned in a table
- Highlight: exceeded targets, hit targets, missed targets
- Focus on meaningful differences (1 rep off is not news)
- Flag: joint discomfort > 0, pump 1-2, significant rep misses

When discussing adjustments:
- Present options, let Harry decide
- Once agreed, update weekly_targets for next week via `save_weekly_targets`

## Weekly Planning Mode

### Review Last Week
1. Call `get_week_summary` for the completed week
2. Show: sessions completed vs planned, avg readiness
3. Per-exercise table: Target | Actual | Pump | Joint | Notes
4. Highlight flags: joint discomfort, low pump (1-2 for 2+ weeks), significant misses

### Generate Next Week -- Auto-Progression Logic

For each exercise, follow this sequence:

**Step 1: Check flags**
- Joint discomfort > 0? Do not progress. Consider swap if 2+ weeks.
- Pump 1-2 for 2+ weeks? Do not add volume. Fix exercise first.
- Missed session? Carry forward unchanged.

**Step 2: Set progression**

| Pump | Soreness (that muscle, pre-session) | Action |
|------|------|--------|
| 1-2 | 0-2 | +1 set |
| 3-4 | 2-3 | Hold |
| 4-5 | 4-5 | -1 set |

Additional: Spread set increases across days. Don't add sets if significantly missing reps. New exercises hold sets for 1 week. If adding a set, hold reps and weight.

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

**Priority when multiple changes possible:**
1. Adding a set -> hold reps, hold weight
2. Increasing reps -> hold weight, hold sets
3. Increasing weight -> reset reps to bottom of range, hold sets

**Only change one lever at a time.**

### Deload
Trigger: every 4th week OR end of mesocycle OR user requests.
Prescription: 50% volume (half the sets), RPE 5-6, same weights.

Present proposed changes in a table. Flag exercises needing manual decision. Confirm before saving.

## Meso Planning Mode

Guide mesocycle design through:
1. Focus (hypertrophy, strength, peaking, deload)
2. Duration (typically 4-8 weeks)
3. Split structure (days and muscle groupings)
4. Exercise selection (respect shoulder/back limitations)
5. Progression model

Always reference existing exercises via `search_exercises` for IDs.
Create via `create_mesocycle`, then `save_weekly_targets` for week 1.
Show the full plan and get explicit confirmation before saving.

## Goal Setting Mode

- Help set goals tied to specific exercises with clear metrics
- Goal types: weight (target weight at given reps), reps (target rep count), time (target duration in seconds)
- Track progress by pulling `get_exercise_history` for current best
- When a goal is hit, call `mark_goal_achieved` and acknowledge genuinely
- Consider limitations when setting goals

## Running

- Run data syncs automatically from Strava (Strava webhook -> database)
- Use `get_run_sessions` and `get_run_detail` to review runs
- Help analyze pace trends, HR zones, and weekly mileage
- Run types: easy, tempo, interval, long, race, fartlek
- Current goal: 5K sub-23:00 (1380 seconds)

## Isolation Exercise Rule

For isolation exercises, pump matters more than reps. If pump is 4-5 but reps are low, the exercise is working. Hold and trust it.

## Myo-rep / Giant Set Rule

Progress by +5 total reps per week (not per set). If missed target, hold.

## Stall Rule

Same reps for 2 weeks at same weight = stall. Consider adding a set.

## "Felt Amazing" but Missed Reps

Hold everything. Accept higher RPE. Don't chase numbers when stimulus is there.

## Drop Set Rule

If exercise consistently drops off hard on later sets, allow a drop set on the final set rather than reducing weight across all sets.

**END INSTRUCTIONS**

---

## 8. Implementation Checklist

Ordered by dependency. Each step must complete before the next can begin within its group.

### Phase 1: Database (no dependencies)

- [ ] **1.1** Create `strava_tokens` table (migration)
- [ ] **1.2** Create `strava_webhook_subscriptions` table (migration)
- [ ] **1.3** Create `strava_sync_log` table (migration)
- [ ] **1.4** Add unique constraint on `workout_exercise_notes(workout_id, exercise_id)` (migration)
- [ ] **1.5** Create all 22 RPC functions (Section 2) via Supabase SQL editor
- [ ] **1.6** Verify each RPC function with a test call via `execute_sql`: `SELECT get_active_mesocycle()`, etc.

### Phase 2: MCP Server (depends on Phase 1)

- [ ] **2.1** Set `MCP_SECRET` environment variable: `supabase secrets set MCP_SECRET=<random> --project-ref xwfshemzhunaxbzjgata`
- [ ] **2.2** Write `mcp-server/index.ts` with all 18 tool registrations
- [ ] **2.3** Write `mcp-server/deno.json`
- [ ] **2.4** Deploy: `supabase functions deploy mcp-server --no-verify-jwt --project-ref xwfshemzhunaxbzjgata`
- [ ] **2.5** Test health endpoint: `curl https://xwfshemzhunaxbzjgata.supabase.co/functions/v1/mcp-server`
- [ ] **2.6** Test MCP endpoint with a tools/list JSON-RPC call
- [ ] **2.7** Test each tool individually via curl with JSON-RPC format

### Phase 3: Strava Token Seeding (depends on Phase 1) — NO AUTH EDGE FUNCTION NEEDED

- [x] **3.1** Create Strava API application at `https://www.strava.com/settings/api` ✓ (Client ID: 206698)
- [ ] **3.2** Set secrets: `supabase secrets set STRAVA_CLIENT_ID=206698 STRAVA_CLIENT_SECRET=14e52a80493f635d5d40bbcaab6bc8624e738112 --project-ref xwfshemzhunaxbzjgata`
- [ ] **3.3** Seed tokens directly via `save_strava_tokens` RPC (Section 6.3)
- [ ] **3.4** Verify tokens saved: `SELECT athlete_id, expires_at FROM strava_tokens`

### Phase 4: Strava Webhook (depends on Phase 1, 3)

- [ ] **4.1** Set verify token secret: `supabase secrets set STRAVA_VERIFY_TOKEN=<random> --project-ref xwfshemzhunaxbzjgata`
- [ ] **4.2** Write and deploy `strava-webhook` edge function
- [ ] **4.3** Create webhook subscription via curl (Section 6.5)
- [ ] **4.4** Verify subscription: `curl "https://www.strava.com/api/v3/push_subscriptions?client_id=206698&client_secret=14e52a80493f635d5d40bbcaab6bc8624e738112"`
- [ ] **4.5** Record a test run on Strava (or use API to create a test activity)
- [ ] **4.6** Verify `run_sessions` populated with correct data
- [ ] **4.7** Verify `run_laps` and `run_hr_zones` populated
- [ ] **4.8** Verify `strava_sync_log` has a success entry
- [ ] **4.9** Test activity update and delete events

### Phase 5: Claude.ai Integration (depends on Phase 2)

- [ ] **5.1** Create Claude.ai project "Workout Tracker"
- [ ] **5.2** Add MCP server: URL = `https://xwfshemzhunaxbzjgata.supabase.co/functions/v1/mcp-server/mcp`, auth token = `<MCP_SECRET>`
- [ ] **5.3** Paste full project instructions (Section 7) into custom instructions
- [ ] **5.4** Test: "What's my current mesocycle?" -- should call `get_active_mesocycle`
- [ ] **5.5** Test: "I'm at the gym, doing Pull today" -- should trigger session mode flow
- [ ] **5.6** Test: "How are my goals?" -- should call `get_goals`
- [ ] **5.7** Test: "Show me my recent runs" -- should call `get_run_sessions`

---

## 9. Testing Plan

### 9.1 Database Function Tests

For each RPC function, run via Supabase SQL editor or MCP `execute_sql`:

| Function | Test Query | Expected |
|---|---|---|
| `get_active_mesocycle` | `SELECT get_active_mesocycle()` | Returns Hybrid Block 1 with 3 days |
| `get_workout_plan` | `SELECT get_workout_plan('<meso_id>', '<day1_id>', 1)` | Returns 7 exercises for Pull day |
| `start_workout` | `SELECT start_workout('<meso_id>', '<day1_id>', 1)` | Returns new workout_id |
| `log_sets` | `SELECT log_sets('<workout_id>', '<pullup_id>', '[{"reps":8,"weight_kg":10},{"reps":7,"weight_kg":10}]'::jsonb)` | Returns logged: 2 |
| `log_exercise_feedback` | `SELECT log_exercise_feedback('<workout_id>', '<pullup_id>', 4, 0, 'good')` | Returns id |
| `end_workout` | `SELECT end_workout('<workout_id>', 4, 'solid session')` | Returns duration_min |
| `search_exercises` | `SELECT search_exercises('bench')` | Returns bench-related exercises |
| `get_goals` | `SELECT get_goals('active')` | Returns 3 goals with current_best |
| `upsert_run_session` | Insert a test run with laps | Returns run_session_id, is_new: true |
| `upsert_run_session` (update) | Same external_id again | Returns is_new: false |
| `delete_run_session_by_external_id` | Delete the test run | Returns deleted: true, cascades laps/zones |

### 9.2 MCP Server Tests

Test with curl using JSON-RPC format:

```bash
# List tools
curl -X POST https://xwfshemzhunaxbzjgata.supabase.co/functions/v1/mcp-server/mcp \
  -H "Authorization: Bearer <MCP_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Call a tool
curl -X POST https://xwfshemzhunaxbzjgata.supabase.co/functions/v1/mcp-server/mcp \
  -H "Authorization: Bearer <MCP_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_active_mesocycle","arguments":{}}}'
```

**Auth test:** Omit the Authorization header -- should return 401.
**Invalid tool test:** Call a non-existent tool -- should return JSON-RPC error.

### 9.3 Strava Webhook Tests

1. **Validation:** `curl "https://xwfshemzhunaxbzjgata.supabase.co/functions/v1/strava-webhook?hub.mode=subscribe&hub.verify_token=<STRAVA_VERIFY_TOKEN>&hub.challenge=test123"` -- should return `{"hub.challenge":"test123"}`
2. **Invalid token:** Same curl with wrong verify_token -- should return 403
3. **Activity create:** Record a run on Strava, check `run_sessions` populates within 30 seconds
4. **Activity update:** Edit the run title on Strava, check `strava_sync_log` shows update event
5. **Activity delete:** Delete the activity on Strava, check `run_sessions` row is deleted
6. **Non-run activity:** Record a bike ride, check `strava_sync_log` shows "skipped" status
7. **Check edge function logs:** `supabase functions logs strava-webhook --project-ref xwfshemzhunaxbzjgata`

### 9.4 Strava Token Seeding Tests

1. Run `SELECT * FROM strava_tokens` -- should have one row with the seeded tokens
2. Verify `expires_at = 0` (forces refresh on first webhook use)
3. After first webhook activity processes, verify `athlete_id` is updated from 0 to real value
4. After first webhook activity processes, verify `expires_at` is updated to a future timestamp

### 9.5 End-to-End Claude.ai Tests

| Test | User Message | Expected Behavior |
|---|---|---|
| Context load | "What's my current training block?" | Calls `get_active_mesocycle`, returns Hybrid Block 1 |
| Session start | "At the gym, doing Pull" | Asks readiness, then shows Pull day plan |
| Log sets | "Pull ups done, 8 7 6 at BW+10" | Calls `log_sets`, confirms, asks pump/joint |
| Session end | "done" | Calls `end_workout`, shows duration, asks for rating |
| Weekly review | "How did last week go?" | Calls `get_week_summary`, shows summary table |
| Goal check | "How am I tracking?" | Calls `get_goals`, shows progress table |
| Run review | "Show me my runs this week" | Calls `get_run_sessions`, shows run summaries |
| Exercise search | "What chest exercises do I have?" | Calls `search_exercises` with muscle_group=chest |

---

### Critical Files for Implementation

- `/home/arry_chmidt/agency/projects/acc-mcp-server/supabase/functions/mcp-server/index.ts` - Template to follow for the MCP edge function structure, tool registration pattern, Hono routing, and Zod schema conversion
- `/home/arry_chmidt/agency/projects/acc-mcp-server/supabase/functions/mcp-server/deno.json` - Exact dependency versions to use (hono, mcp-lite, zod, supabase-js)
- `/home/arry_chmidt/projects/workout-tracker/personas/weekly-planning.md` - Contains the complete auto-progression logic that must be embedded in Claude.ai instructions
- `/home/arry_chmidt/projects/workout-tracker/personas/session-mode.md` - Contains the session flow, input parsing rules, and data storage flow that the MCP tools must support
- `/home/arry_chmidt/projects/workout-tracker/schema.sql` - Current database schema to verify against when writing migrations and RPC functions