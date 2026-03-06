-- =============================================================================
-- Migration: Add subjective readiness columns to workouts and run_sessions
--
-- Context: start_workout RPC was designed to accept sleep_quality, energy_level,
-- and muscle_soreness but the columns were never added to the workouts table.
-- run_sessions also needs these for pre-run readiness tracking.
-- Required for /analyze skill (correlate subjective readiness → performance).
-- =============================================================================

-- 1. Add readiness columns to workouts
-- =============================================================================

ALTER TABLE workouts
  ADD COLUMN IF NOT EXISTS sleep_quality integer CHECK (sleep_quality BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS energy_level integer CHECK (energy_level BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS muscle_soreness jsonb;

-- 2. Add readiness columns to run_sessions
-- =============================================================================

ALTER TABLE run_sessions
  ADD COLUMN IF NOT EXISTS sleep_quality integer CHECK (sleep_quality BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS energy_level integer CHECK (energy_level BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS muscle_soreness jsonb;

-- =============================================================================
-- 3. Recreate start_workout — now INSERTs the readiness columns
--    (The RPC already accepted these params but the INSERT didn't include them)
-- =============================================================================

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

-- =============================================================================
-- 4. New RPC: log_run_readiness
--    Creates a stub run_session with subjective data before the run.
--    Garmin sync (upsert_run_session) will merge into this stub by date.
-- =============================================================================

CREATE OR REPLACE FUNCTION log_run_readiness(
  p_date date DEFAULT CURRENT_DATE,
  p_sleep_quality integer DEFAULT NULL,
  p_energy_level integer DEFAULT NULL,
  p_muscle_soreness jsonb DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  session_id uuid;
  active_meso_id uuid;
  is_new boolean := false;
BEGIN
  -- Get active mesocycle
  SELECT id INTO active_meso_id FROM mesocycles WHERE status = 'active' LIMIT 1;

  -- Check if a run_session already exists for this date
  SELECT id INTO session_id
  FROM run_sessions
  WHERE date = p_date
  ORDER BY created_at DESC
  LIMIT 1;

  IF session_id IS NOT NULL THEN
    -- Update existing row (preserve Garmin data via COALESCE)
    UPDATE run_sessions SET
      sleep_quality = COALESCE(p_sleep_quality, sleep_quality),
      energy_level = COALESCE(p_energy_level, energy_level),
      muscle_soreness = COALESCE(p_muscle_soreness, muscle_soreness),
      notes = COALESCE(p_notes, notes)
    WHERE id = session_id;
  ELSE
    -- Create stub row
    INSERT INTO run_sessions (
      date, source, mesocycle_id,
      sleep_quality, energy_level, muscle_soreness, notes
    ) VALUES (
      p_date, 'manual', active_meso_id,
      p_sleep_quality, p_energy_level, p_muscle_soreness, p_notes
    )
    RETURNING id INTO session_id;
    is_new := true;
  END IF;

  RETURN json_build_object(
    'run_session_id', session_id,
    'is_new', is_new,
    'date', p_date
  );
END;
$$;

-- =============================================================================
-- 5. Modify upsert_run_session — check for manual stub by date before creating
--    new row. Preserves subjective readiness fields via COALESCE.
-- =============================================================================

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
  p_training_effect_aerobic numeric DEFAULT NULL,
  p_training_effect_anaerobic numeric DEFAULT NULL,
  p_vo2_max_estimate numeric DEFAULT NULL,
  p_perceived_effort integer DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_laps jsonb DEFAULT NULL,
  p_hr_zones jsonb DEFAULT NULL,
  p_min_heart_rate integer DEFAULT NULL,
  p_max_cadence integer DEFAULT NULL,
  p_avg_stride_length_m numeric DEFAULT NULL,
  p_steps integer DEFAULT NULL,
  p_avg_temperature_c numeric DEFAULT NULL,
  p_moving_duration_s numeric DEFAULT NULL,
  p_fastest_1km_s numeric DEFAULT NULL,
  p_fastest_mile_s numeric DEFAULT NULL,
  p_fastest_5km_s numeric DEFAULT NULL,
  p_raw_garmin jsonb DEFAULT NULL
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

  -- 1. Check if this external_id already exists
  SELECT id INTO session_id
  FROM run_sessions
  WHERE external_id = p_external_id AND source = p_source;

  -- 2. If no external_id match, check for a manual stub on the same date
  IF session_id IS NULL THEN
    SELECT id INTO session_id
    FROM run_sessions
    WHERE date = p_date AND source = 'manual'
    ORDER BY created_at DESC
    LIMIT 1;
  END IF;

  IF session_id IS NOT NULL THEN
    -- Update existing (COALESCE preserves subjective readiness fields)
    UPDATE run_sessions SET
      external_id = COALESCE(p_external_id, external_id),
      source = COALESCE(p_source, source),
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
      training_effect_aerobic = COALESCE(p_training_effect_aerobic, training_effect_aerobic),
      training_effect_anaerobic = COALESCE(p_training_effect_anaerobic, training_effect_anaerobic),
      vo2_max_estimate = COALESCE(p_vo2_max_estimate, vo2_max_estimate),
      perceived_effort = COALESCE(p_perceived_effort, perceived_effort),
      notes = COALESCE(p_notes, notes),
      min_heart_rate = COALESCE(p_min_heart_rate, min_heart_rate),
      max_cadence = COALESCE(p_max_cadence, max_cadence),
      avg_stride_length_m = COALESCE(p_avg_stride_length_m, avg_stride_length_m),
      steps = COALESCE(p_steps, steps),
      avg_temperature_c = COALESCE(p_avg_temperature_c, avg_temperature_c),
      moving_duration_s = COALESCE(p_moving_duration_s, moving_duration_s),
      fastest_1km_s = COALESCE(p_fastest_1km_s, fastest_1km_s),
      fastest_mile_s = COALESCE(p_fastest_mile_s, fastest_mile_s),
      fastest_5km_s = COALESCE(p_fastest_5km_s, fastest_5km_s),
      raw_garmin = COALESCE(p_raw_garmin, raw_garmin)
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
      training_effect_aerobic, training_effect_anaerobic, vo2_max_estimate,
      perceived_effort, notes, mesocycle_id,
      min_heart_rate, max_cadence, avg_stride_length_m, steps,
      avg_temperature_c, moving_duration_s,
      fastest_1km_s, fastest_mile_s, fastest_5km_s, raw_garmin
    ) VALUES (
      p_external_id, p_source, p_date, p_started_at, p_ended_at, p_run_type,
      p_distance_m, p_duration_s, p_avg_pace_s_per_km,
      p_avg_heart_rate, p_max_heart_rate, p_avg_cadence,
      p_elevation_gain_m, p_elevation_loss_m, p_calories,
      p_training_effect_aerobic, p_training_effect_anaerobic, p_vo2_max_estimate,
      p_perceived_effort, p_notes, active_meso_id,
      p_min_heart_rate, p_max_cadence, p_avg_stride_length_m, p_steps,
      p_avg_temperature_c, p_moving_duration_s,
      p_fastest_1km_s, p_fastest_mile_s, p_fastest_5km_s, p_raw_garmin
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
        avg_cadence, elevation_gain_m,
        elevation_loss_m, avg_stride_length_m, max_cadence
      ) VALUES (
        session_id,
        (lap->>'lap_number')::integer,
        (lap->>'distance_m')::numeric,
        (lap->>'duration_s')::numeric,
        (lap->>'avg_pace_s_per_km')::numeric,
        (lap->>'avg_heart_rate')::integer,
        (lap->>'max_heart_rate')::integer,
        (lap->>'avg_cadence')::integer,
        (lap->>'elevation_gain_m')::numeric,
        (lap->>'elevation_loss_m')::numeric,
        (lap->>'avg_stride_length_m')::numeric,
        (lap->>'max_cadence')::integer
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

-- =============================================================================
-- 6. Update get_run_sessions — include readiness fields in output
-- =============================================================================

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
    'min_heart_rate', rs.min_heart_rate,
    'avg_cadence', rs.avg_cadence,
    'max_cadence', rs.max_cadence,
    'elevation_gain_m', rs.elevation_gain_m,
    'elevation_loss_m', rs.elevation_loss_m,
    'calories', rs.calories,
    'training_effect_aerobic', rs.training_effect_aerobic,
    'training_effect_anaerobic', rs.training_effect_anaerobic,
    'vo2_max_estimate', rs.vo2_max_estimate,
    'avg_stride_length_m', rs.avg_stride_length_m,
    'avg_temperature_c', rs.avg_temperature_c,
    'steps', rs.steps,
    'moving_duration_s', rs.moving_duration_s,
    'fastest_1km_s', rs.fastest_1km_s,
    'fastest_mile_s', rs.fastest_mile_s,
    'fastest_5km_s', rs.fastest_5km_s,
    'perceived_effort', rs.perceived_effort,
    'notes', rs.notes,
    'source', rs.source,
    'external_id', rs.external_id,
    'sleep_quality', rs.sleep_quality,
    'energy_level', rs.energy_level,
    'muscle_soreness', rs.muscle_soreness
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

-- =============================================================================
-- 7. Update get_workout_review — include readiness fields in workout metadata
--    (The build plan already had these in the json_build_object but the columns
--     didn't exist, so they returned null. Now they'll return actual values.)
-- =============================================================================

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
  -- Workout metadata (now includes readiness fields)
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
