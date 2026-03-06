/**
 * Workout Tracker - Custom MCP Server
 *
 * Exposes workout + running tools via MCP protocol.
 * Single-user, bearer token auth. All queries go through SECURITY DEFINER RPC functions.
 *
 * Uses @modelcontextprotocol/sdk (official SDK) with StreamableHTTPServerTransport.
 * Copied from working ACC Transcript MCP pattern.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createClient } from '@supabase/supabase-js'

// =============================================================================
// CONFIGURATION
// =============================================================================

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const MCP_SECRET = Deno.env.get('MCP_SECRET') || ''
const GARMIN_SYNC_SECRET = Deno.env.get('GARMIN_SYNC_SECRET') || ''

if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('FATAL: SUPABASE_SERVICE_ROLE_KEY not set')
if (!MCP_SECRET) throw new Error('FATAL: MCP_SECRET not set')

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// =============================================================================
// AUTH
// =============================================================================

function checkAuth(authHeader: string | undefined): boolean {
  if (!authHeader) return false
  const token = authHeader.replace('Bearer ', '')
  return token === MCP_SECRET
}

// =============================================================================
// HELPERS
// =============================================================================

function textResult(data: unknown) {
  return {
    content: [{
      type: 'text' as const,
      text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
    }],
  }
}

function errorResult(msg: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
}

async function rpc(fnName: string, params?: Record<string, unknown>) {
  const { data, error } = await supabase.rpc(fnName, params || {})
  if (error) throw new Error(`${fnName}: ${error.message}`)
  return data
}

// =============================================================================
// TOOL DEFINITIONS (plain JSON Schema — no Zod)
// =============================================================================

const TOOLS = [
  {
    name: 'get_active_mesocycle',
    description: 'Get the current active mesocycle with its days. Use when user asks about their current training block.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_workout_plan',
    description: 'Get the planned exercises for a specific day and week. Shows targets including sets, reps, weight, and superset groupings.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mesocycle_id: { type: 'string', description: 'Mesocycle UUID' },
        day_id: { type: 'string', description: 'Mesocycle day UUID' },
        week_number: { type: 'number', description: 'Week number (1-6)' },
      },
      required: ['mesocycle_id', 'day_id', 'week_number'],
    },
  },
  {
    name: 'start_workout',
    description: 'Start a new workout session. Returns a workout_id to use for logging sets.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mesocycle_id: { type: 'string', description: 'Mesocycle UUID' },
        mesocycle_day_id: { type: 'string', description: 'Mesocycle day UUID' },
        week_number: { type: 'number', description: 'Week number' },
        date: { type: 'string', description: 'Date (YYYY-MM-DD), defaults to today' },
        sleep_quality: { type: 'number', description: 'Sleep quality 1-5' },
        energy_level: { type: 'number', description: 'Energy level 1-5' },
        muscle_soreness: { type: 'object', description: 'Muscle soreness by group e.g. {"back": 2, "chest": 1} (0-5 per group)' },
        pre_session_notes: { type: 'string', description: 'Pre-session notes' },
      },
      required: ['mesocycle_id', 'mesocycle_day_id', 'week_number'],
    },
  },
  {
    name: 'log_sets',
    description: 'Log one or more sets for an exercise. Pass an array of sets with weight, reps, and optional RPE.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workout_id: { type: 'string', description: 'Workout UUID from start_workout' },
        exercise_id: { type: 'string', description: 'Exercise UUID' },
        sets: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              weight_kg: { type: 'number', description: 'Weight in kg (0 for bodyweight)' },
              weight_added_kg: { type: 'number', description: 'Added weight for BW exercises (e.g. 10 for BW+10kg pull-ups)' },
              reps: { type: 'number', description: 'Number of reps' },
              rpe: { type: 'number', description: 'RPE 1-10' },
              set_type: { type: 'string', description: 'Set type: working, warmup, drop, myo' },
              notes: { type: 'string', description: 'Set notes' },
            },
            required: ['weight_kg', 'reps'],
          },
          description: 'Array of sets to log',
        },
      },
      required: ['workout_id', 'exercise_id', 'sets'],
    },
  },
  {
    name: 'log_exercise_feedback',
    description: 'Record pump quality and joint feedback for an exercise after completing it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workout_id: { type: 'string', description: 'Workout UUID' },
        exercise_id: { type: 'string', description: 'Exercise UUID' },
        pump_quality: { type: 'number', description: 'Pump quality 1-5' },
        joint_discomfort: { type: 'number', description: 'Joint discomfort 0-5 (0 = none)' },
        notes: { type: 'string', description: 'Feedback notes' },
      },
      required: ['workout_id', 'exercise_id'],
    },
  },
  {
    name: 'end_workout',
    description: 'End a workout session. Optionally provide a rating and notes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workout_id: { type: 'string', description: 'Workout UUID' },
        rating: { type: 'number', description: 'Session rating 1-5' },
        notes: { type: 'string', description: 'Post-session notes' },
      },
      required: ['workout_id'],
    },
  },
  {
    name: 'get_workout_review',
    description: 'Get full details of a completed workout: metadata, all sets, and exercise feedback.',
    inputSchema: {
      type: 'object' as const,
      properties: { workout_id: { type: 'string', description: 'Workout UUID' } },
      required: ['workout_id'],
    },
  },
  {
    name: 'get_week_summary',
    description: 'Get all workouts, sets, feedback, and targets for a specific week. Use for weekly reviews.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mesocycle_id: { type: 'string', description: 'Mesocycle UUID' },
        week_number: { type: 'number', description: 'Week number' },
      },
      required: ['mesocycle_id', 'week_number'],
    },
  },
  {
    name: 'save_weekly_targets',
    description: 'Save targets for a week. Replaces any existing targets for that week. Used after weekly review to set next week plan.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mesocycle_id: { type: 'string', description: 'Mesocycle UUID' },
        week_number: { type: 'number', description: 'Week number' },
        targets: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              mesocycle_day_id: { type: 'string', description: 'Day UUID' },
              exercise_id: { type: 'string', description: 'Exercise UUID' },
              exercise_order: { type: 'number', description: 'Order within the day' },
              target_sets: { type: 'number', description: 'Number of sets' },
              target_reps: { type: 'string', description: 'Rep target (e.g. "8-10", "max")' },
              target_weight_kg: { type: 'number', description: 'Target weight in kg' },
              target_rpe: { type: 'string', description: 'Target RPE (e.g. "8", "7-8")' },
              rest_seconds: { type: 'number', description: 'Rest between sets in seconds (e.g. 180 for 3 min)' },
              superset_group: { type: 'string', description: 'Superset group (A, B1, B2, etc.)' },
              notes: { type: 'string', description: 'Notes' },
            },
            required: ['mesocycle_day_id', 'exercise_id', 'exercise_order', 'target_sets', 'target_reps'],
          },
          description: 'Array of exercise targets',
        },
      },
      required: ['mesocycle_id', 'week_number', 'targets'],
    },
  },
  {
    name: 'get_exercise_history',
    description: 'Get progression history for an exercise. Shows max weight and reps over time.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        exercise_id: { type: 'string', description: 'Exercise UUID' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: ['exercise_id'],
    },
  },
  {
    name: 'get_volume_summary',
    description: 'Get weekly volume by muscle group for a mesocycle. Shows total sets and volume.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mesocycle_id: { type: 'string', description: 'Mesocycle UUID (defaults to active)' },
        weeks: { type: 'number', description: 'Number of weeks to include (default 4)' },
      },
    },
  },
  {
    name: 'get_goals',
    description: 'Get training goals with current progress. Shows target vs current best.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', enum: ['active', 'achieved', 'all'], description: 'Filter by status (default: active)' },
      },
    },
  },
  {
    name: 'upsert_goal',
    description: 'Create or update a training goal.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        exercise_id: { type: 'string', description: 'Exercise UUID' },
        goal_type: { type: 'string', enum: ['weight_pr', 'rep_pr', 'time'], description: 'Goal type' },
        target_value: { type: 'number', description: 'Target value (weight in kg, 0 for BW, or seconds for time)' },
        target_reps: { type: 'number', description: 'Target reps (for rep_pr goals)' },
        target_date: { type: 'string', description: 'Target date (YYYY-MM-DD)' },
        mesocycle_id: { type: 'string', description: 'Mesocycle UUID' },
        notes: { type: 'string', description: 'Goal notes' },
        id: { type: 'string', description: 'Existing goal UUID to update' },
      },
      required: ['exercise_id', 'goal_type', 'target_value'],
    },
  },
  {
    name: 'mark_goal_achieved',
    description: 'Mark a goal as achieved.',
    inputSchema: {
      type: 'object' as const,
      properties: { goal_id: { type: 'string', description: 'Goal UUID' } },
      required: ['goal_id'],
    },
  },
  {
    name: 'search_exercises',
    description: 'Search exercises by name, muscle group, or equipment. Use to find exercise IDs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search by name (partial match)' },
        muscle_group: { type: 'string', description: 'Filter by muscle group' },
        equipment: { type: 'string', description: 'Filter by equipment' },
      },
    },
  },
  {
    name: 'create_mesocycle',
    description: 'Create a new mesocycle. Automatically marks any active mesocycle as completed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Mesocycle name' },
        focus: { type: 'string', description: 'Training focus' },
        start_date: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        end_date: { type: 'string', description: 'End date (YYYY-MM-DD)' },
        notes: { type: 'string', description: 'Mesocycle notes' },
        days: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              day_number: { type: 'number', description: 'Day number (1-based)' },
              name: { type: 'string', description: 'Day name' },
              notes: { type: 'string', description: 'Day notes' },
            },
            required: ['day_number', 'name'],
          },
          description: 'Training days',
        },
      },
      required: ['name', 'focus', 'start_date'],
    },
  },
  {
    name: 'update_mesocycle',
    description: 'Update an existing mesocycle. Use to edit name, focus, notes, dates, or status mid-block. Only provided fields are updated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mesocycle_id: { type: 'string', description: 'Mesocycle UUID' },
        name: { type: 'string', description: 'New mesocycle name' },
        focus: { type: 'string', description: 'New training focus' },
        start_date: { type: 'string', description: 'New start date (YYYY-MM-DD)' },
        end_date: { type: 'string', description: 'New end date (YYYY-MM-DD)' },
        notes: { type: 'string', description: 'New mesocycle notes (replaces existing)' },
        status: { type: 'string', enum: ['active', 'completed', 'paused'], description: 'New status' },
      },
      required: ['mesocycle_id'],
    },
  },
  {
    name: 'get_run_sessions',
    description: 'Get recent run sessions. Filter by type or date range.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Max results (default 10)' },
        run_type: { type: 'string', enum: ['easy', 'tempo', 'interval', 'long', 'race', 'fartlek'], description: 'Filter by run type' },
        date_from: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        date_to: { type: 'string', description: 'End date (YYYY-MM-DD)' },
      },
    },
  },
  {
    name: 'get_run_detail',
    description: 'Get full details of a run including lap splits and heart rate zones.',
    inputSchema: {
      type: 'object' as const,
      properties: { run_session_id: { type: 'string', description: 'Run session UUID' } },
      required: ['run_session_id'],
    },
  },
  {
    name: 'get_exercise_cues',
    description: 'Get the most recent exercise feedback notes for a list of exercises. Cross-mesocycle — returns latest cues regardless of block. Use when displaying a workout plan to surface setup notes like "drop the seat" or "use wide grip bar".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        exercise_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of exercise UUIDs',
        },
      },
      required: ['exercise_ids'],
    },
  },
  {
    name: 'update_set',
    description: 'Update a logged set. Only provided fields are changed. Use when user says "that was wrong" or "change the last set".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        set_id: { type: 'string', description: 'Workout set UUID' },
        weight_kg: { type: 'number', description: 'New weight in kg' },
        reps: { type: 'number', description: 'New rep count' },
        rpe: { type: 'number', description: 'New RPE' },
        set_type: { type: 'string', description: 'New set type' },
        notes: { type: 'string', description: 'New notes' },
        weight_added_kg: { type: 'number', description: 'New added weight for BW exercises' },
      },
      required: ['set_id'],
    },
  },
  {
    name: 'delete_set',
    description: 'Delete a logged set. Use when user says "remove that set" or logged a set by mistake.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        set_id: { type: 'string', description: 'Workout set UUID to delete' },
      },
      required: ['set_id'],
    },
  },
  {
    name: 'update_weekly_target',
    description: 'Update a single weekly target and propagate changes to all future weeks. Use for mid-block plan adjustments: changing weight, sets, reps, superset groups, exercise swaps, or reordering.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Weekly target UUID' },
        mesocycle_id: { type: 'string', description: 'Mesocycle UUID' },
        week_number: { type: 'number', description: 'Week number of the target being updated' },
        exercise_id: { type: 'string', description: 'New exercise UUID (for exercise swaps)' },
        exercise_order: { type: 'number', description: 'New exercise order within the day' },
        target_sets: { type: 'number', description: 'New number of sets' },
        target_reps: { type: 'string', description: 'New rep target (e.g. "8-10", "max")' },
        target_weight_kg: { type: 'number', description: 'New target weight in kg' },
        target_rpe: { type: 'string', description: 'New target RPE (e.g. "8", "7-8")' },
        rest_seconds: { type: 'number', description: 'New rest between sets in seconds' },
        superset_group: { type: 'string', description: 'New superset group (A, B1, B2, etc.)' },
        notes: { type: 'string', description: 'New notes' },
      },
      required: ['id', 'mesocycle_id', 'week_number'],
    },
  },
  {
    name: 'sync_garmin_data',
    description: 'Trigger an on-demand sync of Garmin health data. Call before readiness checks, weekly reviews, or when user asks about health data. Returns which endpoints succeeded/failed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: 'Date to sync (YYYY-MM-DD), defaults to today' },
      },
    },
  },
  {
    name: 'get_daily_health',
    description: 'Full Garmin health snapshot for a date: sleep (score + stages), HRV (value + status), Body Battery, Training Readiness (score + components), Training Status, Stress, Resting HR, Respiration. Defaults to today.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: 'Date (YYYY-MM-DD), defaults to today' },
      },
    },
  },
  {
    name: 'get_health_trends',
    description: 'Multi-day health trends for correlating with training. Returns daily summaries (sleep score, HRV, body battery, readiness, stress, RHR) over a date range. Use during weekly reviews.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        date_from: { type: 'string', description: 'Start date (YYYY-MM-DD), defaults to 7 days ago' },
        date_to: { type: 'string', description: 'End date (YYYY-MM-DD), defaults to today' },
      },
    },
  },
  {
    name: 'get_readiness',
    description: 'Quick pre-workout snapshot: readiness score + level, body battery morning, HRV last night + status, sleep score + duration, resting HR, stress avg. Call at the start of every session.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: 'Date (YYYY-MM-DD), defaults to today' },
      },
    },
  },
  {
    name: 'update_run_session',
    description: 'Update a run session after completion. Set run_type, notes, perceived_effort, or readiness fields. Only provided fields are changed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        run_session_id: { type: 'string', description: 'Run session UUID' },
        run_type: { type: 'string', enum: ['easy', 'tempo', 'interval', 'long', 'race', 'fartlek'], description: 'Run type classification' },
        notes: { type: 'string', description: 'Run notes' },
        perceived_effort: { type: 'number', description: 'Perceived effort 1-10' },
        sleep_quality: { type: 'number', description: 'Sleep quality 1-5' },
        energy_level: { type: 'number', description: 'Energy level 1-5' },
        muscle_soreness: { type: 'object', description: 'Muscle soreness by group e.g. {"quads": 2} (0-5 per group)' },
        target_cadence_spm: { type: 'number', description: 'Target cadence in steps per minute' },
        target_pace_s_per_km: { type: 'number', description: 'Target pace in seconds per km' },
        target_hr_min: { type: 'number', description: 'Minimum target heart rate' },
        target_hr_max: { type: 'number', description: 'Maximum target heart rate' },
      },
      required: ['run_session_id'],
    },
  },
  {
    name: 'get_weekly_run_targets',
    description: 'Get the planned run sessions for a specific week. Shows run type, pace, HR targets, interval structure, cadence targets.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mesocycle_id: { type: 'string', description: 'Mesocycle UUID' },
        week_number: { type: 'number', description: 'Week number' },
      },
      required: ['mesocycle_id', 'week_number'],
    },
  },
  {
    name: 'save_weekly_run_targets',
    description: 'Save run session targets for a week. Replaces existing targets for that week.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mesocycle_id: { type: 'string', description: 'Mesocycle UUID' },
        week_number: { type: 'number', description: 'Week number' },
        targets: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              day_of_week: { type: 'string', description: 'Day of week (mon, tue, wed, thu, fri, sat, sun)' },
              run_type: { type: 'string', description: 'Run type (easy, tempo, interval, long, fartlek, race)' },
              duration_min: { type: 'number', description: 'Duration in minutes' },
              distance_km: { type: 'number', description: 'Distance in km' },
              target_pace_text: { type: 'string', description: 'e.g. "6:30-7:30/km"' },
              target_hr_text: { type: 'string', description: 'e.g. "HR <145"' },
              target_cadence_spm: { type: 'number', description: 'Target cadence' },
              intervals_count: { type: 'number', description: 'Number of intervals' },
              interval_distance_m: { type: 'number', description: 'Interval distance in meters' },
              interval_pace_text: { type: 'string', description: 'Interval pace target' },
              recovery_text: { type: 'string', description: 'Recovery between intervals' },
              warmup_text: { type: 'string', description: 'Warm-up protocol' },
              cooldown_text: { type: 'string', description: 'Cool-down protocol' },
              notes: { type: 'string', description: 'Additional notes' },
            },
            required: ['day_of_week', 'run_type'],
          },
          description: 'Array of run targets',
        },
      },
      required: ['mesocycle_id', 'week_number', 'targets'],
    },
  },
  {
    name: 'log_run_readiness',
    description: 'Log pre-run subjective readiness. Creates a stub run session that Garmin sync will merge into. Call when user says they are heading out for a run.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: 'Date (YYYY-MM-DD), defaults to today' },
        sleep_quality: { type: 'number', description: 'Sleep quality 1-5' },
        energy_level: { type: 'number', description: 'Energy level 1-5' },
        muscle_soreness: { type: 'object', description: 'Muscle soreness by group e.g. {"quads": 2, "calves": 1} (0-5 per group)' },
        notes: { type: 'string', description: 'Pre-run notes' },
      },
    },
  },
]

// =============================================================================
// TOOL HANDLER
// =============================================================================

async function handleToolCall(name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'get_active_mesocycle':
      return textResult(await rpc('get_active_mesocycle'))
    case 'get_workout_plan':
      return textResult(await rpc('get_workout_plan', {
        p_mesocycle_id: args.mesocycle_id, p_day_id: args.day_id, p_week_number: args.week_number,
      }))
    case 'start_workout': {
      const params: Record<string, unknown> = {
        p_mesocycle_id: args.mesocycle_id, p_mesocycle_day_id: args.mesocycle_day_id,
        p_week_number: args.week_number,
        p_sleep_quality: args.sleep_quality || null, p_energy_level: args.energy_level || null,
        p_muscle_soreness: args.muscle_soreness || null, p_pre_session_notes: args.pre_session_notes || null,
      }
      // Only pass p_date if explicitly provided — let the RPC default to CURRENT_DATE
      if (args.date) params.p_date = args.date
      return textResult(await rpc('start_workout', params))
    }
    case 'log_sets':
      return textResult(await rpc('log_sets', {
        p_workout_id: args.workout_id, p_exercise_id: args.exercise_id, p_sets: args.sets,
      }))
    case 'log_exercise_feedback':
      return textResult(await rpc('log_exercise_feedback', {
        p_workout_id: args.workout_id, p_exercise_id: args.exercise_id,
        p_pump_quality: args.pump_quality || null, p_joint_discomfort: args.joint_discomfort || null,
        p_notes: args.notes || null,
      }))
    case 'end_workout':
      return textResult(await rpc('end_workout', {
        p_workout_id: args.workout_id, p_rating: args.rating || null, p_notes: args.notes || null,
      }))
    case 'get_workout_review':
      return textResult(await rpc('get_workout_review', { p_workout_id: args.workout_id }))
    case 'get_week_summary':
      return textResult(await rpc('get_week_summary', {
        p_mesocycle_id: args.mesocycle_id, p_week_number: args.week_number,
      }))
    case 'save_weekly_targets':
      return textResult(await rpc('save_weekly_targets', {
        p_mesocycle_id: args.mesocycle_id, p_week_number: args.week_number, p_targets: args.targets,
      }))
    case 'get_exercise_history':
      return textResult(await rpc('get_exercise_history', {
        p_exercise_id: args.exercise_id, p_limit: args.limit || 20,
      }))
    case 'get_volume_summary':
      return textResult(await rpc('get_volume_summary', {
        p_mesocycle_id: args.mesocycle_id || null, p_weeks: args.weeks || 4,
      }))
    case 'get_goals':
      return textResult(await rpc('get_goals', { p_status: args.status || 'active' }))
    case 'upsert_goal':
      return textResult(await rpc('upsert_goal', {
        p_exercise_id: args.exercise_id, p_goal_type: args.goal_type, p_target_value: args.target_value,
        p_target_reps: args.target_reps || null, p_target_date: args.target_date || null,
        p_mesocycle_id: args.mesocycle_id || null, p_notes: args.notes || null, p_id: args.id || null,
      }))
    case 'mark_goal_achieved':
      return textResult(await rpc('mark_goal_achieved', { p_goal_id: args.goal_id }))
    case 'search_exercises':
      return textResult(await rpc('search_exercises', {
        p_query: args.query || null, p_muscle_group: args.muscle_group || null, p_equipment: args.equipment || null,
      }))
    case 'create_mesocycle':
      return textResult(await rpc('create_mesocycle', {
        p_name: args.name, p_focus: args.focus, p_start_date: args.start_date,
        p_end_date: args.end_date || null, p_notes: args.notes || null, p_days: args.days || null,
      }))
    case 'update_mesocycle':
      return textResult(await rpc('update_mesocycle', {
        p_mesocycle_id: args.mesocycle_id,
        p_name: args.name || null, p_focus: args.focus || null,
        p_start_date: args.start_date || null, p_end_date: args.end_date || null,
        p_notes: args.notes || null, p_status: args.status || null,
      }))
    case 'get_run_sessions':
      return textResult(await rpc('get_run_sessions', {
        p_limit: args.limit || 10, p_run_type: args.run_type || null,
        p_date_from: args.date_from || null, p_date_to: args.date_to || null,
      }))
    case 'get_run_detail':
      return textResult(await rpc('get_run_detail', { p_run_session_id: args.run_session_id }))
    case 'get_exercise_cues':
      return textResult(await rpc('get_exercise_cues', {
        p_exercise_ids: args.exercise_ids,
      }))
    case 'update_set': {
      const params: Record<string, unknown> = { p_set_id: args.set_id }
      if (args.weight_kg !== undefined) params.p_weight_kg = args.weight_kg
      if (args.reps !== undefined) params.p_reps = args.reps
      if (args.rpe !== undefined) params.p_rpe = args.rpe
      if (args.set_type !== undefined) params.p_set_type = args.set_type
      if (args.notes !== undefined) params.p_notes = args.notes
      if (args.weight_added_kg !== undefined) params.p_weight_added_kg = args.weight_added_kg
      return textResult(await rpc('update_set', params))
    }
    case 'delete_set':
      return textResult(await rpc('delete_set', { p_set_id: args.set_id }))
    case 'update_weekly_target': {
      const params: Record<string, unknown> = {
        p_id: args.id, p_mesocycle_id: args.mesocycle_id, p_week_number: args.week_number,
      }
      if (args.exercise_id !== undefined) params.p_exercise_id = args.exercise_id
      if (args.exercise_order !== undefined) params.p_exercise_order = args.exercise_order
      if (args.target_sets !== undefined) params.p_target_sets = args.target_sets
      if (args.target_reps !== undefined) params.p_target_reps = args.target_reps
      if (args.target_weight_kg !== undefined) params.p_target_weight_kg = args.target_weight_kg
      if (args.superset_group !== undefined) params.p_superset_group = args.superset_group
      if (args.notes !== undefined) params.p_notes = args.notes
      if (args.target_rpe !== undefined) params.p_target_rpe = args.target_rpe
      if (args.rest_seconds !== undefined) params.p_rest_seconds = args.rest_seconds
      return textResult(await rpc('update_weekly_target', params))
    }
    case 'sync_garmin_data': {
      if (!GARMIN_SYNC_SECRET) throw new Error('GARMIN_SYNC_SECRET not configured')
      const headers = {
        Authorization: `Bearer ${GARMIN_SYNC_SECRET}`,
        'Content-Type': 'application/json',
      }
      // Sync daily health + runs in parallel
      const [dailyResp, runResp] = await Promise.all([
        fetch(`${SUPABASE_URL}/functions/v1/garmin-sync/daily`, {
          method: 'POST', headers,
          body: JSON.stringify({ date: args.date || undefined }),
        }),
        fetch(`${SUPABASE_URL}/functions/v1/garmin-sync/run-sync`, {
          method: 'POST', headers,
          body: '{}',
        }),
      ])
      const dailyResult = await dailyResp.json()
      const runResult = await runResp.json()
      return textResult({ daily: dailyResult, runs: runResult })
    }
    case 'get_daily_health':
      return textResult(await rpc('get_garmin_daily_summary', {
        p_date: args.date || new Date().toISOString().split('T')[0],
      }))
    case 'get_health_trends': {
      const params: Record<string, unknown> = {}
      if (args.date_from) params.p_date_from = args.date_from
      if (args.date_to) params.p_date_to = args.date_to
      return textResult(await rpc('get_garmin_daily_summaries_range', params))
    }
    case 'get_readiness':
      return textResult(await rpc('get_garmin_readiness_snapshot', {
        p_date: args.date || new Date().toISOString().split('T')[0],
      }))
    case 'update_run_session': {
      const params: Record<string, unknown> = { p_run_session_id: args.run_session_id }
      if (args.run_type !== undefined) params.p_run_type = args.run_type
      if (args.notes !== undefined) params.p_notes = args.notes
      if (args.perceived_effort !== undefined) params.p_perceived_effort = args.perceived_effort
      if (args.sleep_quality !== undefined) params.p_sleep_quality = args.sleep_quality
      if (args.energy_level !== undefined) params.p_energy_level = args.energy_level
      if (args.muscle_soreness !== undefined) params.p_muscle_soreness = args.muscle_soreness
      if (args.target_cadence_spm !== undefined) params.p_target_cadence_spm = args.target_cadence_spm
      if (args.target_pace_s_per_km !== undefined) params.p_target_pace_s_per_km = args.target_pace_s_per_km
      if (args.target_hr_min !== undefined) params.p_target_hr_min = args.target_hr_min
      if (args.target_hr_max !== undefined) params.p_target_hr_max = args.target_hr_max
      return textResult(await rpc('update_run_session', params))
    }
    case 'log_run_readiness': {
      const params: Record<string, unknown> = {
        p_sleep_quality: args.sleep_quality || null,
        p_energy_level: args.energy_level || null,
        p_muscle_soreness: args.muscle_soreness || null,
        p_notes: args.notes || null,
      }
      if (args.date) params.p_date = args.date
      return textResult(await rpc('log_run_readiness', params))
    }
    case 'get_weekly_run_targets':
      return textResult(await rpc('get_weekly_run_targets', {
        p_mesocycle_id: args.mesocycle_id, p_week_number: args.week_number,
      }))
    case 'save_weekly_run_targets':
      return textResult(await rpc('save_weekly_run_targets', {
        p_mesocycle_id: args.mesocycle_id, p_week_number: args.week_number, p_targets: args.targets,
      }))
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// =============================================================================
// MCP SERVER FACTORY (official SDK — same as ACC)
// =============================================================================

function createMcpServer(): Server {
  const server = new Server(
    { name: 'workout-tracker', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    console.log(`[MCP] Tool call: ${name}`)
    try {
      return await handleToolCall(name, (args || {}) as Record<string, unknown>)
    } catch (e) {
      console.error(`[MCP] Tool error (${name}):`, e)
      return errorResult((e as Error).message)
    }
  })

  return server
}

// =============================================================================
// HTTP SERVER (Deno.serve + WebStandardStreamableHTTPServerTransport)
// =============================================================================

function addCorsHeaders(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('Access-Control-Allow-Origin', '*')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url)
  const path = url.pathname.replace('/mcp-server', '') // strip function prefix

  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, Mcp-Session-Id, Mcp-Protocol-Version',
      },
    })
  }

  // Health check
  if (req.method === 'GET' && (path === '' || path === '/')) {
    return Response.json({
      name: 'Workout Tracker MCP Server',
      version: '1.0.0',
      status: 'healthy',
      tools: TOOLS.length,
    })
  }

  if (req.method === 'GET' && path === '/health') {
    return Response.json({ status: 'ok', timestamp: new Date().toISOString() })
  }

  // MCP endpoint
  if (path === '/mcp') {
    console.log(`[MCP] ${req.method} request`)

    // GET on /mcp — return server info (not handled by SDK)
    if (req.method === 'GET') {
      return Response.json({
        name: 'Workout Tracker MCP Server',
        version: '1.0.0',
        status: 'healthy',
        tools: TOOLS.length,
      })
    }

    // Only POST is valid for MCP protocol
    if (req.method !== 'POST' && req.method !== 'DELETE') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 })
    }

    try {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })

      const mcpServer = createMcpServer()
      await mcpServer.connect(transport)

      // WORKAROUND: Always set the Accept header the SDK expects.
      // The SDK requires both application/json AND text/event-stream even when
      // enableJsonResponse: true means we only return JSON. Claude.ai may send
      // any Accept value. Force the correct one on all /mcp POST requests.
      const newHeaders = new Headers(req.headers)
      newHeaders.set('accept', 'application/json, text/event-stream')
      const requestToHandle = new Request(req.url, {
        method: req.method,
        headers: newHeaders,
        body: req.body,
        // @ts-ignore — Deno supports duplex on Request
        duplex: 'half',
      })

      const response = await transport.handleRequest(requestToHandle)
      return addCorsHeaders(response)
    } catch (error: any) {
      console.error(`[MCP] Error:`, error)
      return Response.json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: error.message },
      }, { status: 500 })
    }
  }

  return Response.json({ error: 'Not found' }, { status: 404 })
})
