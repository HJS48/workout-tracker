-- =============================================================================
-- Migration: Training Block V2 — schema changes for DUP, weighted BW exercises,
-- RPE targets, rest periods, structured run prescriptions
-- =============================================================================

-- 1. Add target_rpe and rest_seconds to weekly_targets
ALTER TABLE weekly_targets ADD COLUMN IF NOT EXISTS target_rpe text;
ALTER TABLE weekly_targets ADD COLUMN IF NOT EXISTS rest_seconds integer;

-- 2. Add weight_added_kg to workout_sets (for weighted pull-ups, dips, etc.)
ALTER TABLE workout_sets ADD COLUMN IF NOT EXISTS weight_added_kg numeric;

-- 3. Add run target fields to run_sessions
ALTER TABLE run_sessions ADD COLUMN IF NOT EXISTS target_cadence_spm integer;
ALTER TABLE run_sessions ADD COLUMN IF NOT EXISTS target_pace_s_per_km numeric;
ALTER TABLE run_sessions ADD COLUMN IF NOT EXISTS target_hr_min integer;
ALTER TABLE run_sessions ADD COLUMN IF NOT EXISTS target_hr_max integer;

-- 4. Create weekly_run_targets table
CREATE TABLE IF NOT EXISTS weekly_run_targets (
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

-- =============================================================================
-- 5. Update save_weekly_targets to accept target_rpe + rest_seconds
-- =============================================================================
CREATE OR REPLACE FUNCTION save_weekly_targets(
  p_mesocycle_id uuid,
  p_week_number integer,
  p_targets jsonb
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
  -- Delete existing targets for this week
  DELETE FROM weekly_targets
  WHERE mesocycle_id = p_mesocycle_id AND week_number = p_week_number;

  -- Insert new targets
  FOR target IN SELECT * FROM jsonb_array_elements(p_targets)
  LOOP
    INSERT INTO weekly_targets (
      mesocycle_id, week_number, mesocycle_day_id, exercise_id,
      exercise_order, target_sets, target_reps, target_weight_kg,
      superset_group, notes, target_rpe, rest_seconds
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
      target->>'notes',
      target->>'target_rpe',
      (target->>'rest_seconds')::integer
    );
    inserted_count := inserted_count + 1;
  END LOOP;

  RETURN json_build_object('saved', inserted_count, 'week_number', p_week_number);
END;
$$;

-- =============================================================================
-- 6. Update get_workout_plan to return target_rpe + rest_seconds
-- =============================================================================
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
  SELECT json_agg(row_order) INTO result
  FROM (
    SELECT json_build_object(
      'id', wt.id,
      'exercise_id', wt.exercise_id,
      'exercise_name', e.name,
      'muscle_group', e.muscle_group,
      'equipment', e.equipment,
      'exercise_order', wt.exercise_order,
      'target_sets', wt.target_sets,
      'target_reps', wt.target_reps,
      'target_weight_kg', wt.target_weight_kg,
      'target_rpe', wt.target_rpe,
      'rest_seconds', wt.rest_seconds,
      'superset_group', wt.superset_group,
      'notes', wt.notes
    ) AS row_order
    FROM weekly_targets wt
    JOIN exercises e ON e.id = wt.exercise_id
    WHERE wt.mesocycle_id = p_mesocycle_id
      AND wt.mesocycle_day_id = p_day_id
      AND wt.week_number = p_week_number
    ORDER BY wt.exercise_order
  ) sub;

  RETURN COALESCE(result, '[]'::json);
END;
$$;

-- =============================================================================
-- 7. Update log_sets to accept weight_added_kg
-- =============================================================================
CREATE OR REPLACE FUNCTION log_sets(
  p_workout_id uuid,
  p_exercise_id uuid,
  p_sets jsonb
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s jsonb;
  current_order integer;
  logged_count integer := 0;
BEGIN
  -- Get current max set_order for this workout
  SELECT COALESCE(MAX(set_order), 0) INTO current_order
  FROM workout_sets WHERE workout_id = p_workout_id;

  FOR s IN SELECT * FROM jsonb_array_elements(p_sets)
  LOOP
    current_order := current_order + 1;
    INSERT INTO workout_sets (
      workout_id, exercise_id, set_order, weight_kg, reps, rpe, set_type, notes, weight_added_kg
    ) VALUES (
      p_workout_id,
      p_exercise_id,
      current_order,
      (s->>'weight_kg')::numeric,
      (s->>'reps')::integer,
      (s->>'rpe')::numeric,
      s->>'set_type',
      s->>'notes',
      (s->>'weight_added_kg')::numeric
    );
    logged_count := logged_count + 1;
  END LOOP;

  RETURN json_build_object(
    'logged', logged_count,
    'exercise_id', p_exercise_id,
    'workout_id', p_workout_id
  );
END;
$$;

-- =============================================================================
-- 8. Update update_set to accept weight_added_kg
-- =============================================================================
CREATE OR REPLACE FUNCTION update_set(
  p_set_id uuid,
  p_weight_kg numeric DEFAULT NULL,
  p_reps integer DEFAULT NULL,
  p_rpe numeric DEFAULT NULL,
  p_set_type text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_weight_added_kg numeric DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result json;
BEGIN
  UPDATE workout_sets SET
    weight_kg = COALESCE(p_weight_kg, weight_kg),
    reps = COALESCE(p_reps, reps),
    rpe = COALESCE(p_rpe, rpe),
    set_type = COALESCE(p_set_type, set_type),
    notes = COALESCE(p_notes, notes),
    weight_added_kg = COALESCE(p_weight_added_kg, weight_added_kg)
  WHERE id = p_set_id
  RETURNING json_build_object(
    'set_id', id, 'weight_kg', weight_kg, 'reps', reps,
    'rpe', rpe, 'set_type', set_type, 'notes', notes,
    'weight_added_kg', weight_added_kg
  ) INTO result;

  IF result IS NULL THEN
    RAISE EXCEPTION 'Set not found: %', p_set_id;
  END IF;

  RETURN result;
END;
$$;

-- =============================================================================
-- 9. Update update_weekly_target to accept target_rpe + rest_seconds
-- =============================================================================
CREATE OR REPLACE FUNCTION update_weekly_target(
  p_id uuid,
  p_mesocycle_id uuid,
  p_week_number integer,
  p_exercise_id uuid DEFAULT NULL,
  p_exercise_order integer DEFAULT NULL,
  p_target_sets integer DEFAULT NULL,
  p_target_reps text DEFAULT NULL,
  p_target_weight_kg numeric DEFAULT NULL,
  p_superset_group text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_target_rpe text DEFAULT NULL,
  p_rest_seconds integer DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result json;
  original record;
  total_weeks integer;
  w integer;
BEGIN
  -- Get original values
  SELECT * INTO original FROM weekly_targets WHERE id = p_id;
  IF original IS NULL THEN
    RAISE EXCEPTION 'Weekly target not found: %', p_id;
  END IF;

  -- Get total weeks
  SELECT COALESCE(
    EXTRACT(DAY FROM (m.end_date - m.start_date))::integer / 7,
    6
  ) INTO total_weeks FROM mesocycles m WHERE m.id = p_mesocycle_id;

  -- Update current week
  UPDATE weekly_targets SET
    exercise_id = COALESCE(p_exercise_id, exercise_id),
    exercise_order = COALESCE(p_exercise_order, exercise_order),
    target_sets = COALESCE(p_target_sets, target_sets),
    target_reps = COALESCE(p_target_reps, target_reps),
    target_weight_kg = COALESCE(p_target_weight_kg, target_weight_kg),
    superset_group = COALESCE(p_superset_group, superset_group),
    notes = COALESCE(p_notes, notes),
    target_rpe = COALESCE(p_target_rpe, target_rpe),
    rest_seconds = COALESCE(p_rest_seconds, rest_seconds)
  WHERE id = p_id;

  -- Propagate to future weeks
  FOR w IN (p_week_number + 1)..total_weeks LOOP
    UPDATE weekly_targets SET
      exercise_id = COALESCE(p_exercise_id, exercise_id),
      exercise_order = COALESCE(p_exercise_order, exercise_order),
      target_sets = COALESCE(p_target_sets, target_sets),
      target_reps = COALESCE(p_target_reps, target_reps),
      target_weight_kg = COALESCE(p_target_weight_kg, target_weight_kg),
      superset_group = COALESCE(p_superset_group, superset_group),
      notes = COALESCE(p_notes, notes),
      target_rpe = COALESCE(p_target_rpe, target_rpe),
      rest_seconds = COALESCE(p_rest_seconds, rest_seconds)
    WHERE mesocycle_id = p_mesocycle_id
      AND week_number = w
      AND mesocycle_day_id = original.mesocycle_day_id
      AND exercise_order = original.exercise_order;
  END LOOP;

  SELECT json_build_object('updated', true, 'week_number', p_week_number) INTO result;
  RETURN result;
END;
$$;

-- =============================================================================
-- 10. Update update_run_session to accept target fields
-- =============================================================================
CREATE OR REPLACE FUNCTION update_run_session(
  p_run_session_id uuid,
  p_run_type text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_perceived_effort integer DEFAULT NULL,
  p_sleep_quality integer DEFAULT NULL,
  p_energy_level integer DEFAULT NULL,
  p_muscle_soreness jsonb DEFAULT NULL,
  p_target_cadence_spm integer DEFAULT NULL,
  p_target_pace_s_per_km numeric DEFAULT NULL,
  p_target_hr_min integer DEFAULT NULL,
  p_target_hr_max integer DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result json;
BEGIN
  UPDATE run_sessions SET
    run_type = COALESCE(p_run_type, run_type),
    notes = COALESCE(p_notes, notes),
    perceived_effort = COALESCE(p_perceived_effort, perceived_effort),
    sleep_quality = COALESCE(p_sleep_quality, sleep_quality),
    energy_level = COALESCE(p_energy_level, energy_level),
    muscle_soreness = COALESCE(p_muscle_soreness, muscle_soreness),
    target_cadence_spm = COALESCE(p_target_cadence_spm, target_cadence_spm),
    target_pace_s_per_km = COALESCE(p_target_pace_s_per_km, target_pace_s_per_km),
    target_hr_min = COALESCE(p_target_hr_min, target_hr_min),
    target_hr_max = COALESCE(p_target_hr_max, target_hr_max)
  WHERE id = p_run_session_id
  RETURNING json_build_object(
    'run_session_id', id,
    'date', date,
    'run_type', run_type,
    'notes', notes,
    'perceived_effort', perceived_effort,
    'target_cadence_spm', target_cadence_spm,
    'target_pace_s_per_km', target_pace_s_per_km,
    'target_hr_min', target_hr_min,
    'target_hr_max', target_hr_max
  ) INTO result;

  IF result IS NULL THEN
    RAISE EXCEPTION 'Run session not found: %', p_run_session_id;
  END IF;

  RETURN result;
END;
$$;

-- =============================================================================
-- 11. New RPC: get_weekly_run_targets
-- =============================================================================
CREATE OR REPLACE FUNCTION get_weekly_run_targets(
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
  SELECT json_agg(row_to_json(t)) INTO result
  FROM (
    SELECT id, week_number, day_of_week, run_type,
      duration_min, distance_km, target_pace_text, target_hr_text,
      target_cadence_spm, intervals_count, interval_distance_m,
      interval_pace_text, recovery_text, warmup_text, cooldown_text, notes
    FROM weekly_run_targets
    WHERE mesocycle_id = p_mesocycle_id AND week_number = p_week_number
    ORDER BY CASE day_of_week
      WHEN 'mon' THEN 1 WHEN 'tue' THEN 2 WHEN 'wed' THEN 3
      WHEN 'thu' THEN 4 WHEN 'fri' THEN 5 WHEN 'sat' THEN 6 WHEN 'sun' THEN 7
    END
  ) t;

  RETURN COALESCE(result, '[]'::json);
END;
$$;

-- =============================================================================
-- 12. New RPC: save_weekly_run_targets
-- =============================================================================
CREATE OR REPLACE FUNCTION save_weekly_run_targets(
  p_mesocycle_id uuid,
  p_week_number integer,
  p_targets jsonb
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
  -- Delete existing targets for this week
  DELETE FROM weekly_run_targets
  WHERE mesocycle_id = p_mesocycle_id AND week_number = p_week_number;

  -- Insert new targets
  FOR target IN SELECT * FROM jsonb_array_elements(p_targets)
  LOOP
    INSERT INTO weekly_run_targets (
      mesocycle_id, week_number, day_of_week, run_type,
      duration_min, distance_km, target_pace_text, target_hr_text,
      target_cadence_spm, intervals_count, interval_distance_m,
      interval_pace_text, recovery_text, warmup_text, cooldown_text, notes
    ) VALUES (
      p_mesocycle_id,
      p_week_number,
      target->>'day_of_week',
      target->>'run_type',
      (target->>'duration_min')::integer,
      (target->>'distance_km')::numeric,
      target->>'target_pace_text',
      target->>'target_hr_text',
      (target->>'target_cadence_spm')::integer,
      (target->>'intervals_count')::integer,
      (target->>'interval_distance_m')::integer,
      target->>'interval_pace_text',
      target->>'recovery_text',
      target->>'warmup_text',
      target->>'cooldown_text',
      target->>'notes'
    );
    inserted_count := inserted_count + 1;
  END LOOP;

  RETURN json_build_object('saved', inserted_count, 'week_number', p_week_number);
END;
$$;
