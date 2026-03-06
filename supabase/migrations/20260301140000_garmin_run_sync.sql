-- =============================================================================
-- GARMIN RUN SYNC — New columns + updated RPCs
-- Switches run data source from Strava to Garmin Connect (richer data).
-- 2026-03-01
-- =============================================================================

-- =============================================================================
-- 1. NEW COLUMNS ON run_sessions
-- =============================================================================

ALTER TABLE run_sessions
  ADD COLUMN IF NOT EXISTS min_heart_rate integer,
  ADD COLUMN IF NOT EXISTS max_cadence integer,
  ADD COLUMN IF NOT EXISTS avg_stride_length_m numeric,
  ADD COLUMN IF NOT EXISTS steps integer,
  ADD COLUMN IF NOT EXISTS avg_temperature_c numeric,
  ADD COLUMN IF NOT EXISTS moving_duration_s numeric,
  ADD COLUMN IF NOT EXISTS fastest_1km_s numeric,
  ADD COLUMN IF NOT EXISTS fastest_mile_s numeric,
  ADD COLUMN IF NOT EXISTS fastest_5km_s numeric,
  ADD COLUMN IF NOT EXISTS raw_garmin jsonb;

-- =============================================================================
-- 2. NEW COLUMNS ON run_laps
-- =============================================================================

ALTER TABLE run_laps
  ADD COLUMN IF NOT EXISTS elevation_loss_m numeric,
  ADD COLUMN IF NOT EXISTS avg_stride_length_m numeric,
  ADD COLUMN IF NOT EXISTS max_cadence integer;

-- =============================================================================
-- 3. UNIQUE INDEX for dedup (external_id + source)
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_run_sessions_external_source
  ON run_sessions (external_id, source)
  WHERE external_id IS NOT NULL;

-- =============================================================================
-- 4. UPDATED upsert_run_session — new Garmin-specific params
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
  -- New Garmin-specific params
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

  -- Insert laps (with new Garmin columns)
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
-- 5. UPDATED get_run_sessions — add new Garmin fields to output
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

-- =============================================================================
-- 6. get_run_detail — uses row_to_json(rs.*) so auto-picks up new session columns.
--    Update lap subquery to include new columns explicitly for clarity.
-- =============================================================================

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
      SELECT json_agg(json_build_object(
        'lap_number', rl.lap_number,
        'distance_m', rl.distance_m,
        'duration_s', rl.duration_s,
        'avg_pace_s_per_km', rl.avg_pace_s_per_km,
        'avg_heart_rate', rl.avg_heart_rate,
        'max_heart_rate', rl.max_heart_rate,
        'avg_cadence', rl.avg_cadence,
        'elevation_gain_m', rl.elevation_gain_m,
        'elevation_loss_m', rl.elevation_loss_m,
        'avg_stride_length_m', rl.avg_stride_length_m,
        'max_cadence', rl.max_cadence
      ) ORDER BY rl.lap_number)
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
