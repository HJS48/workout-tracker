-- =============================================================================
-- Migration: Exercise cues carry-over + set editing tools
--
-- 1. get_exercise_cues — returns most recent workout_exercise_notes per exercise
--    Cross-mesocycle by design (queries by exercise_id, not mesocycle)
-- 2. update_set — COALESCE update, only provided fields change
-- 3. delete_set — hard delete, returns deleted set info
-- =============================================================================

-- 1. get_exercise_cues
-- =============================================================================

CREATE OR REPLACE FUNCTION get_exercise_cues(p_exercise_ids uuid[])
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result json;
BEGIN
  SELECT json_agg(sub) INTO result
  FROM (
    SELECT DISTINCT ON (wen.exercise_id)
      wen.exercise_id,
      e.name AS exercise_name,
      wen.notes,
      w.date
    FROM workout_exercise_notes wen
    JOIN exercises e ON wen.exercise_id = e.id
    JOIN workouts w ON wen.workout_id = w.id
    WHERE wen.exercise_id = ANY(p_exercise_ids)
      AND wen.notes IS NOT NULL
      AND wen.notes != ''
    ORDER BY wen.exercise_id, w.date DESC
  ) sub;

  RETURN COALESCE(result, '[]'::json);
END;
$$;

-- 2. update_set
-- =============================================================================

CREATE OR REPLACE FUNCTION update_set(
  p_set_id uuid,
  p_weight_kg numeric DEFAULT NULL,
  p_reps integer DEFAULT NULL,
  p_rpe numeric DEFAULT NULL,
  p_set_type text DEFAULT NULL,
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
  UPDATE workout_sets SET
    weight_kg = COALESCE(p_weight_kg, weight_kg),
    reps = COALESCE(p_reps, reps),
    rpe = COALESCE(p_rpe, rpe),
    set_type = COALESCE(p_set_type, set_type),
    notes = COALESCE(p_notes, notes)
  WHERE id = p_set_id
  RETURNING json_build_object(
    'set_id', id,
    'exercise_id', exercise_id,
    'weight_kg', weight_kg,
    'reps', reps,
    'rpe', rpe,
    'set_type', set_type,
    'notes', notes
  ) INTO result;

  IF result IS NULL THEN
    RAISE EXCEPTION 'Set not found: %', p_set_id;
  END IF;

  RETURN result;
END;
$$;

-- 3. delete_set
-- =============================================================================

CREATE OR REPLACE FUNCTION delete_set(p_set_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result json;
BEGIN
  DELETE FROM workout_sets
  WHERE id = p_set_id
  RETURNING json_build_object(
    'set_id', id,
    'exercise_id', exercise_id,
    'weight_kg', weight_kg,
    'reps', reps,
    'rpe', rpe,
    'set_type', set_type,
    'notes', notes
  ) INTO result;

  IF result IS NULL THEN
    RAISE EXCEPTION 'Set not found: %', p_set_id;
  END IF;

  RETURN result;
END;
$$;
