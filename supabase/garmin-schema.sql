-- =============================================================================
-- GARMIN CONNECT SYNC PIPELINE — SCHEMA
-- Run in Supabase SQL Editor
-- =============================================================================

-- =============================================================================
-- TABLES
-- =============================================================================

-- Single row: OAuth1 + OAuth2 tokens from garth
CREATE TABLE garmin_tokens (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  display_name text NOT NULL,
  oauth1_token text NOT NULL,
  oauth1_token_secret text NOT NULL,
  oauth2_access_token text NOT NULL,
  oauth2_expires_at bigint NOT NULL,
  consumer_key text NOT NULL,
  consumer_secret text NOT NULL,
  oauth1_created_at timestamp with time zone DEFAULT now(),
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- One row per date — all Garmin health metrics
CREATE TABLE garmin_daily_summaries (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  summary_date date NOT NULL UNIQUE,

  -- Sleep
  sleep_duration_s integer,
  sleep_score integer,
  sleep_deep_s integer,
  sleep_light_s integer,
  sleep_rem_s integer,
  sleep_awake_s integer,

  -- HRV
  hrv_weekly_avg numeric,
  hrv_last_night numeric,
  hrv_status text,

  -- Body Battery
  body_battery_morning integer,
  body_battery_high integer,
  body_battery_low integer,
  body_battery_during_sleep integer,

  -- Training Readiness
  training_readiness_score integer,
  training_readiness_level text,
  training_readiness_hrv_score numeric,
  training_readiness_sleep_score numeric,
  training_readiness_recovery_score numeric,
  training_readiness_activity_score numeric,

  -- Training Status
  training_status text,
  training_load_7d numeric,
  training_load_28d numeric,
  vo2_max numeric,

  -- Stress
  stress_avg integer,
  stress_max integer,
  stress_high_s integer,
  stress_medium_s integer,
  stress_low_s integer,
  stress_rest_s integer,

  -- Vitals
  resting_heart_rate integer,
  min_heart_rate integer,
  seven_day_avg_rhr integer,
  avg_respiration_rate numeric,

  -- Sleep quality
  measurable_asleep_s integer,
  measurable_awake_s integer,

  -- Activity
  total_steps integer,
  active_seconds integer,
  sedentary_seconds integer,

  -- Raw JSONB for future-proofing
  raw_sleep jsonb,
  raw_hrv jsonb,
  raw_body_battery jsonb,
  raw_training_readiness jsonb,
  raw_training_status jsonb,
  raw_stress jsonb,
  raw_daily_summary jsonb,
  raw_respiration jsonb,

  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE INDEX idx_garmin_daily_summaries_date ON garmin_daily_summaries (summary_date);

-- Audit trail (same pattern as strava_sync_log)
CREATE TABLE garmin_sync_log (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  sync_type text NOT NULL,  -- daily_summary, activity_backfill, token_refresh
  sync_date date,
  status text NOT NULL,     -- success, partial, error
  error_message text,
  duration_ms integer,
  details jsonb,
  created_at timestamp with time zone DEFAULT now()
);

CREATE INDEX idx_garmin_sync_log_created ON garmin_sync_log (created_at DESC);

-- =============================================================================
-- RPC FUNCTIONS
-- =============================================================================

-- 1. Get Garmin tokens
CREATE OR REPLACE FUNCTION get_garmin_tokens()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result json;
BEGIN
  SELECT json_build_object(
    'display_name', display_name,
    'oauth1_token', oauth1_token,
    'oauth1_token_secret', oauth1_token_secret,
    'oauth2_access_token', oauth2_access_token,
    'oauth2_expires_at', oauth2_expires_at,
    'consumer_key', consumer_key,
    'consumer_secret', consumer_secret
  ) INTO result
  FROM garmin_tokens
  LIMIT 1;

  RETURN result;
END;
$$;

-- 2. Save Garmin tokens (upsert — single row)
CREATE OR REPLACE FUNCTION save_garmin_tokens(
  p_display_name text,
  p_oauth1_token text,
  p_oauth1_token_secret text,
  p_oauth2_access_token text,
  p_oauth2_expires_at bigint,
  p_consumer_key text,
  p_consumer_secret text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result_id uuid;
BEGIN
  -- Delete any existing tokens (single user)
  DELETE FROM garmin_tokens WHERE id IS NOT NULL;

  INSERT INTO garmin_tokens (
    display_name, oauth1_token, oauth1_token_secret,
    oauth2_access_token, oauth2_expires_at,
    consumer_key, consumer_secret
  ) VALUES (
    p_display_name, p_oauth1_token, p_oauth1_token_secret,
    p_oauth2_access_token, p_oauth2_expires_at,
    p_consumer_key, p_consumer_secret
  )
  RETURNING id INTO result_id;

  RETURN json_build_object('id', result_id, 'status', 'saved');
END;
$$;

-- 3. Update OAuth2 access token (after refresh)
CREATE OR REPLACE FUNCTION update_garmin_oauth2_token(
  p_oauth2_access_token text,
  p_oauth2_expires_at bigint
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE garmin_tokens
  SET oauth2_access_token = p_oauth2_access_token,
      oauth2_expires_at = p_oauth2_expires_at,
      updated_at = now();

  RETURN json_build_object('status', 'updated');
END;
$$;

-- 4. Upsert daily summary (COALESCE — partial syncs don't overwrite existing data)
CREATE OR REPLACE FUNCTION upsert_garmin_daily_summary(
  p_summary_date date,
  p_sleep_duration_s integer DEFAULT NULL,
  p_sleep_score integer DEFAULT NULL,
  p_sleep_deep_s integer DEFAULT NULL,
  p_sleep_light_s integer DEFAULT NULL,
  p_sleep_rem_s integer DEFAULT NULL,
  p_sleep_awake_s integer DEFAULT NULL,
  p_hrv_weekly_avg numeric DEFAULT NULL,
  p_hrv_last_night numeric DEFAULT NULL,
  p_hrv_status text DEFAULT NULL,
  p_body_battery_morning integer DEFAULT NULL,
  p_body_battery_high integer DEFAULT NULL,
  p_body_battery_low integer DEFAULT NULL,
  p_body_battery_during_sleep integer DEFAULT NULL,
  p_training_readiness_score integer DEFAULT NULL,
  p_training_readiness_level text DEFAULT NULL,
  p_training_readiness_hrv_score numeric DEFAULT NULL,
  p_training_readiness_sleep_score numeric DEFAULT NULL,
  p_training_readiness_recovery_score numeric DEFAULT NULL,
  p_training_readiness_activity_score numeric DEFAULT NULL,
  p_training_status text DEFAULT NULL,
  p_training_load_7d numeric DEFAULT NULL,
  p_training_load_28d numeric DEFAULT NULL,
  p_vo2_max numeric DEFAULT NULL,
  p_stress_avg integer DEFAULT NULL,
  p_stress_max integer DEFAULT NULL,
  p_stress_high_s integer DEFAULT NULL,
  p_stress_medium_s integer DEFAULT NULL,
  p_stress_low_s integer DEFAULT NULL,
  p_stress_rest_s integer DEFAULT NULL,
  p_resting_heart_rate integer DEFAULT NULL,
  p_min_heart_rate integer DEFAULT NULL,
  p_seven_day_avg_rhr integer DEFAULT NULL,
  p_avg_respiration_rate numeric DEFAULT NULL,
  p_measurable_asleep_s integer DEFAULT NULL,
  p_measurable_awake_s integer DEFAULT NULL,
  p_total_steps integer DEFAULT NULL,
  p_active_seconds integer DEFAULT NULL,
  p_sedentary_seconds integer DEFAULT NULL,
  p_raw_sleep jsonb DEFAULT NULL,
  p_raw_hrv jsonb DEFAULT NULL,
  p_raw_body_battery jsonb DEFAULT NULL,
  p_raw_training_readiness jsonb DEFAULT NULL,
  p_raw_training_status jsonb DEFAULT NULL,
  p_raw_stress jsonb DEFAULT NULL,
  p_raw_daily_summary jsonb DEFAULT NULL,
  p_raw_respiration jsonb DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result_id uuid;
BEGIN
  INSERT INTO garmin_daily_summaries (
    summary_date,
    sleep_duration_s, sleep_score, sleep_deep_s, sleep_light_s, sleep_rem_s, sleep_awake_s,
    hrv_weekly_avg, hrv_last_night, hrv_status,
    body_battery_morning, body_battery_high, body_battery_low, body_battery_during_sleep,
    training_readiness_score, training_readiness_level,
    training_readiness_hrv_score, training_readiness_sleep_score,
    training_readiness_recovery_score, training_readiness_activity_score,
    training_status, training_load_7d, training_load_28d, vo2_max,
    stress_avg, stress_max, stress_high_s, stress_medium_s, stress_low_s, stress_rest_s,
    resting_heart_rate, min_heart_rate, seven_day_avg_rhr, avg_respiration_rate,
    measurable_asleep_s, measurable_awake_s,
    total_steps, active_seconds, sedentary_seconds,
    raw_sleep, raw_hrv, raw_body_battery, raw_training_readiness,
    raw_training_status, raw_stress, raw_daily_summary, raw_respiration
  ) VALUES (
    p_summary_date,
    p_sleep_duration_s, p_sleep_score, p_sleep_deep_s, p_sleep_light_s, p_sleep_rem_s, p_sleep_awake_s,
    p_hrv_weekly_avg, p_hrv_last_night, p_hrv_status,
    p_body_battery_morning, p_body_battery_high, p_body_battery_low, p_body_battery_during_sleep,
    p_training_readiness_score, p_training_readiness_level,
    p_training_readiness_hrv_score, p_training_readiness_sleep_score,
    p_training_readiness_recovery_score, p_training_readiness_activity_score,
    p_training_status, p_training_load_7d, p_training_load_28d, p_vo2_max,
    p_stress_avg, p_stress_max, p_stress_high_s, p_stress_medium_s, p_stress_low_s, p_stress_rest_s,
    p_resting_heart_rate, p_min_heart_rate, p_seven_day_avg_rhr, p_avg_respiration_rate,
    p_measurable_asleep_s, p_measurable_awake_s,
    p_total_steps, p_active_seconds, p_sedentary_seconds,
    p_raw_sleep, p_raw_hrv, p_raw_body_battery, p_raw_training_readiness,
    p_raw_training_status, p_raw_stress, p_raw_daily_summary, p_raw_respiration
  )
  ON CONFLICT (summary_date) DO UPDATE SET
    sleep_duration_s = COALESCE(EXCLUDED.sleep_duration_s, garmin_daily_summaries.sleep_duration_s),
    sleep_score = COALESCE(EXCLUDED.sleep_score, garmin_daily_summaries.sleep_score),
    sleep_deep_s = COALESCE(EXCLUDED.sleep_deep_s, garmin_daily_summaries.sleep_deep_s),
    sleep_light_s = COALESCE(EXCLUDED.sleep_light_s, garmin_daily_summaries.sleep_light_s),
    sleep_rem_s = COALESCE(EXCLUDED.sleep_rem_s, garmin_daily_summaries.sleep_rem_s),
    sleep_awake_s = COALESCE(EXCLUDED.sleep_awake_s, garmin_daily_summaries.sleep_awake_s),
    hrv_weekly_avg = COALESCE(EXCLUDED.hrv_weekly_avg, garmin_daily_summaries.hrv_weekly_avg),
    hrv_last_night = COALESCE(EXCLUDED.hrv_last_night, garmin_daily_summaries.hrv_last_night),
    hrv_status = COALESCE(EXCLUDED.hrv_status, garmin_daily_summaries.hrv_status),
    body_battery_morning = COALESCE(EXCLUDED.body_battery_morning, garmin_daily_summaries.body_battery_morning),
    body_battery_high = COALESCE(EXCLUDED.body_battery_high, garmin_daily_summaries.body_battery_high),
    body_battery_low = COALESCE(EXCLUDED.body_battery_low, garmin_daily_summaries.body_battery_low),
    body_battery_during_sleep = COALESCE(EXCLUDED.body_battery_during_sleep, garmin_daily_summaries.body_battery_during_sleep),
    training_readiness_score = COALESCE(EXCLUDED.training_readiness_score, garmin_daily_summaries.training_readiness_score),
    training_readiness_level = COALESCE(EXCLUDED.training_readiness_level, garmin_daily_summaries.training_readiness_level),
    training_readiness_hrv_score = COALESCE(EXCLUDED.training_readiness_hrv_score, garmin_daily_summaries.training_readiness_hrv_score),
    training_readiness_sleep_score = COALESCE(EXCLUDED.training_readiness_sleep_score, garmin_daily_summaries.training_readiness_sleep_score),
    training_readiness_recovery_score = COALESCE(EXCLUDED.training_readiness_recovery_score, garmin_daily_summaries.training_readiness_recovery_score),
    training_readiness_activity_score = COALESCE(EXCLUDED.training_readiness_activity_score, garmin_daily_summaries.training_readiness_activity_score),
    training_status = COALESCE(EXCLUDED.training_status, garmin_daily_summaries.training_status),
    training_load_7d = COALESCE(EXCLUDED.training_load_7d, garmin_daily_summaries.training_load_7d),
    training_load_28d = COALESCE(EXCLUDED.training_load_28d, garmin_daily_summaries.training_load_28d),
    vo2_max = COALESCE(EXCLUDED.vo2_max, garmin_daily_summaries.vo2_max),
    stress_avg = COALESCE(EXCLUDED.stress_avg, garmin_daily_summaries.stress_avg),
    stress_max = COALESCE(EXCLUDED.stress_max, garmin_daily_summaries.stress_max),
    stress_high_s = COALESCE(EXCLUDED.stress_high_s, garmin_daily_summaries.stress_high_s),
    stress_medium_s = COALESCE(EXCLUDED.stress_medium_s, garmin_daily_summaries.stress_medium_s),
    stress_low_s = COALESCE(EXCLUDED.stress_low_s, garmin_daily_summaries.stress_low_s),
    stress_rest_s = COALESCE(EXCLUDED.stress_rest_s, garmin_daily_summaries.stress_rest_s),
    resting_heart_rate = COALESCE(EXCLUDED.resting_heart_rate, garmin_daily_summaries.resting_heart_rate),
    min_heart_rate = COALESCE(EXCLUDED.min_heart_rate, garmin_daily_summaries.min_heart_rate),
    seven_day_avg_rhr = COALESCE(EXCLUDED.seven_day_avg_rhr, garmin_daily_summaries.seven_day_avg_rhr),
    avg_respiration_rate = COALESCE(EXCLUDED.avg_respiration_rate, garmin_daily_summaries.avg_respiration_rate),
    measurable_asleep_s = COALESCE(EXCLUDED.measurable_asleep_s, garmin_daily_summaries.measurable_asleep_s),
    measurable_awake_s = COALESCE(EXCLUDED.measurable_awake_s, garmin_daily_summaries.measurable_awake_s),
    total_steps = COALESCE(EXCLUDED.total_steps, garmin_daily_summaries.total_steps),
    active_seconds = COALESCE(EXCLUDED.active_seconds, garmin_daily_summaries.active_seconds),
    sedentary_seconds = COALESCE(EXCLUDED.sedentary_seconds, garmin_daily_summaries.sedentary_seconds),
    raw_sleep = COALESCE(EXCLUDED.raw_sleep, garmin_daily_summaries.raw_sleep),
    raw_hrv = COALESCE(EXCLUDED.raw_hrv, garmin_daily_summaries.raw_hrv),
    raw_body_battery = COALESCE(EXCLUDED.raw_body_battery, garmin_daily_summaries.raw_body_battery),
    raw_training_readiness = COALESCE(EXCLUDED.raw_training_readiness, garmin_daily_summaries.raw_training_readiness),
    raw_training_status = COALESCE(EXCLUDED.raw_training_status, garmin_daily_summaries.raw_training_status),
    raw_stress = COALESCE(EXCLUDED.raw_stress, garmin_daily_summaries.raw_stress),
    raw_daily_summary = COALESCE(EXCLUDED.raw_daily_summary, garmin_daily_summaries.raw_daily_summary),
    raw_respiration = COALESCE(EXCLUDED.raw_respiration, garmin_daily_summaries.raw_respiration),
    updated_at = now()
  RETURNING id INTO result_id;

  RETURN json_build_object('id', result_id, 'date', p_summary_date, 'status', 'upserted');
END;
$$;

-- 5. Update run_sessions with Garmin metrics (backfill TE/VO2)
CREATE OR REPLACE FUNCTION update_run_session_garmin_metrics(
  p_run_session_id uuid,
  p_training_effect_aerobic numeric DEFAULT NULL,
  p_training_effect_anaerobic numeric DEFAULT NULL,
  p_vo2_max_estimate numeric DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE run_sessions
  SET training_effect_aerobic = COALESCE(p_training_effect_aerobic, training_effect_aerobic),
      training_effect_anaerobic = COALESCE(p_training_effect_anaerobic, training_effect_anaerobic),
      vo2_max_estimate = COALESCE(p_vo2_max_estimate, vo2_max_estimate)
  WHERE id = p_run_session_id;

  IF NOT FOUND THEN
    RETURN json_build_object('status', 'not_found', 'run_session_id', p_run_session_id);
  END IF;

  RETURN json_build_object('status', 'updated', 'run_session_id', p_run_session_id);
END;
$$;

-- 6. Get daily summary for a specific date
CREATE OR REPLACE FUNCTION get_garmin_daily_summary(
  p_date date DEFAULT CURRENT_DATE
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
    'summary_date', summary_date,
    'sleep', json_build_object(
      'duration_s', sleep_duration_s,
      'score', sleep_score,
      'deep_s', sleep_deep_s,
      'light_s', sleep_light_s,
      'rem_s', sleep_rem_s,
      'awake_s', sleep_awake_s
    ),
    'hrv', json_build_object(
      'weekly_avg', hrv_weekly_avg,
      'last_night', hrv_last_night,
      'status', hrv_status
    ),
    'body_battery', json_build_object(
      'morning', body_battery_morning,
      'high', body_battery_high,
      'low', body_battery_low,
      'during_sleep', body_battery_during_sleep
    ),
    'training_readiness', json_build_object(
      'score', training_readiness_score,
      'level', training_readiness_level,
      'hrv_score', training_readiness_hrv_score,
      'sleep_score', training_readiness_sleep_score,
      'recovery_score', training_readiness_recovery_score,
      'activity_score', training_readiness_activity_score
    ),
    'training_status', json_build_object(
      'status', training_status,
      'load_7d', training_load_7d,
      'load_28d', training_load_28d,
      'vo2_max', vo2_max
    ),
    'stress', json_build_object(
      'avg', stress_avg,
      'max', stress_max,
      'high_s', stress_high_s,
      'medium_s', stress_medium_s,
      'low_s', stress_low_s,
      'rest_s', stress_rest_s
    ),
    'vitals', json_build_object(
      'resting_heart_rate', resting_heart_rate,
      'min_heart_rate', min_heart_rate,
      'seven_day_avg_rhr', seven_day_avg_rhr,
      'avg_respiration_rate', avg_respiration_rate
    ),
    'sleep_quality', json_build_object(
      'measurable_asleep_s', measurable_asleep_s,
      'measurable_awake_s', measurable_awake_s
    ),
    'activity', json_build_object(
      'total_steps', total_steps,
      'active_seconds', active_seconds,
      'sedentary_seconds', sedentary_seconds
    )
  ) INTO result
  FROM garmin_daily_summaries
  WHERE summary_date = p_date;

  RETURN result;
END;
$$;

-- 7. Get daily summaries for a date range (trends)
CREATE OR REPLACE FUNCTION get_garmin_daily_summaries_range(
  p_date_from date DEFAULT CURRENT_DATE - INTERVAL '7 days',
  p_date_to date DEFAULT CURRENT_DATE
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
    'date', summary_date,
    'sleep_score', sleep_score,
    'sleep_duration_s', sleep_duration_s,
    'hrv_last_night', hrv_last_night,
    'hrv_status', hrv_status,
    'body_battery_morning', body_battery_morning,
    'training_readiness_score', training_readiness_score,
    'training_readiness_level', training_readiness_level,
    'stress_avg', stress_avg,
    'resting_heart_rate', resting_heart_rate,
    'seven_day_avg_rhr', seven_day_avg_rhr,
    'min_heart_rate', min_heart_rate,
    'body_battery_during_sleep', body_battery_during_sleep,
    'measurable_asleep_s', measurable_asleep_s,
    'total_steps', total_steps,
    'vo2_max', vo2_max,
    'training_status', training_status
  ) ORDER BY summary_date) INTO result
  FROM garmin_daily_summaries
  WHERE summary_date BETWEEN p_date_from AND p_date_to;

  RETURN COALESCE(result, '[]'::json);
END;
$$;

-- =============================================================================
-- RUN SYNC RPCs (updated 2026-03-01 — Garmin as primary run data source)
-- =============================================================================

-- 9. Upsert run session (with Garmin-specific columns)
-- See migration 20260301140000_garmin_run_sync.sql for full definition.
-- New columns: min_heart_rate, max_cadence, avg_stride_length_m, steps,
-- avg_temperature_c, moving_duration_s, fastest_1km_s, fastest_mile_s,
-- fastest_5km_s, raw_garmin jsonb
-- Lap columns: elevation_loss_m, avg_stride_length_m, max_cadence

-- 10. get_run_sessions — includes new Garmin fields in output
-- 11. get_run_detail — laps now include elevation_loss_m, avg_stride_length_m, max_cadence

-- 8. Quick readiness snapshot (pre-workout)
CREATE OR REPLACE FUNCTION get_garmin_readiness_snapshot(
  p_date date DEFAULT CURRENT_DATE
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
    'date', summary_date,
    'readiness_score', training_readiness_score,
    'readiness_level', training_readiness_level,
    'body_battery_morning', body_battery_morning,
    'hrv_last_night', hrv_last_night,
    'hrv_status', hrv_status,
    'sleep_score', sleep_score,
    'sleep_duration_s', sleep_duration_s,
    'resting_heart_rate', resting_heart_rate,
    'min_heart_rate', min_heart_rate,
    'seven_day_avg_rhr', seven_day_avg_rhr,
    'body_battery_during_sleep', body_battery_during_sleep,
    'measurable_asleep_s', measurable_asleep_s,
    'stress_avg', stress_avg
  ) INTO result
  FROM garmin_daily_summaries
  WHERE summary_date = p_date;

  RETURN result;
END;
$$;
