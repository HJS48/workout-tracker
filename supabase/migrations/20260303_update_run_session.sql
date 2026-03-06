-- =============================================================================
-- Migration: update_run_session — partial update for run session metadata
--
-- Context: Post-run flow needs to classify run_type, add notes, and perceived
-- effort. Previously there was no way to update a run_session after creation.
-- Same COALESCE pattern as update_set.
-- =============================================================================

CREATE OR REPLACE FUNCTION update_run_session(
  p_run_session_id uuid,
  p_run_type text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_perceived_effort integer DEFAULT NULL,
  p_sleep_quality integer DEFAULT NULL,
  p_energy_level integer DEFAULT NULL,
  p_muscle_soreness jsonb DEFAULT NULL
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
    muscle_soreness = COALESCE(p_muscle_soreness, muscle_soreness)
  WHERE id = p_run_session_id
  RETURNING json_build_object(
    'run_session_id', id,
    'date', date,
    'run_type', run_type,
    'notes', notes,
    'perceived_effort', perceived_effort,
    'sleep_quality', sleep_quality,
    'energy_level', energy_level,
    'muscle_soreness', muscle_soreness
  ) INTO result;

  IF result IS NULL THEN
    RAISE EXCEPTION 'Run session not found: %', p_run_session_id;
  END IF;

  RETURN result;
END;
$$;
