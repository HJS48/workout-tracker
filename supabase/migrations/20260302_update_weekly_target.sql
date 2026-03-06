-- Update a single weekly_target row and propagate changes to all future weeks.
-- COALESCE pattern: only provided fields are changed, NULL means "keep existing".
-- Propagation: matches rows in weeks > p_week_number by (mesocycle_id, mesocycle_day_id, original_exercise_id, exercise_order).

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
  p_notes text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  orig record;
  updated record;
  propagated integer;
BEGIN
  -- 1. Capture original values before update (for propagation matching)
  SELECT exercise_id, mesocycle_day_id, exercise_order
    INTO orig
    FROM weekly_targets
   WHERE id = p_id AND mesocycle_id = p_mesocycle_id AND week_number = p_week_number;

  IF orig IS NULL THEN
    RAISE EXCEPTION 'Weekly target not found: id=%, mesocycle=%, week=%', p_id, p_mesocycle_id, p_week_number;
  END IF;

  -- 2. Update the target row
  UPDATE weekly_targets SET
    exercise_id      = COALESCE(p_exercise_id, exercise_id),
    exercise_order   = COALESCE(p_exercise_order, exercise_order),
    target_sets      = COALESCE(p_target_sets, target_sets),
    target_reps      = COALESCE(p_target_reps, target_reps),
    target_weight_kg = COALESCE(p_target_weight_kg, target_weight_kg),
    superset_group   = COALESCE(p_superset_group, superset_group),
    notes            = COALESCE(p_notes, notes)
  WHERE id = p_id
  RETURNING * INTO updated;

  -- 3. Propagate to all future weeks matching the original (day, exercise, order)
  UPDATE weekly_targets SET
    exercise_id      = COALESCE(p_exercise_id, exercise_id),
    exercise_order   = COALESCE(p_exercise_order, exercise_order),
    target_sets      = COALESCE(p_target_sets, target_sets),
    target_reps      = COALESCE(p_target_reps, target_reps),
    target_weight_kg = COALESCE(p_target_weight_kg, target_weight_kg),
    superset_group   = COALESCE(p_superset_group, superset_group),
    notes            = COALESCE(p_notes, notes)
  WHERE mesocycle_id = p_mesocycle_id
    AND mesocycle_day_id = orig.mesocycle_day_id
    AND exercise_id = orig.exercise_id
    AND exercise_order = orig.exercise_order
    AND week_number > p_week_number;

  GET DIAGNOSTICS propagated = ROW_COUNT;

  RETURN json_build_object(
    'updated', row_to_json(updated),
    'propagated_weeks', propagated
  );
END;
$$;
