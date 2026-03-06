# Workout Tracker — Project Memory

## Tech Stack
- [2026-02-27] Supabase (Postgres) — project ref: xwfshemzhunaxbzjgata
- [2026-02-27] Schema: mesocycles → mesocycle_days → mesocycle_planned_exercises, workouts → workout_sets, goals, weekly_targets
- [2026-02-27] Running tables: run_sessions, run_laps, run_hr_zones (Garmin Connect sync target)
- [2026-02-28] Custom MCP server (Supabase Edge Function, Deno/TypeScript) — @modelcontextprotocol/sdk@1.27.1 WebStandardStreamableHTTPServerTransport
- [2026-03-06] 31 MCP tools deployed (--no-verify-jwt required for Supabase edge functions)
- [2026-03-01] Claude.ai Skills: gym-session, run-session, weekly-review (uploaded as zips)
- [2026-02-28] Strava tables: strava_tokens, strava_webhook_subscriptions, strava_sync_log
- [2026-02-28] strava-webhook edge function (Garmin → Strava → webhook → Supabase)
- [2026-02-28] Build plan: docs/custom-mcp-build-plan.md

## Architecture
- [2026-03-01] Garmin → garmin-sync edge function → Supabase (primary run data source)
- [2026-02-28] Garmin → Strava (auto-sync) → Webhook → strava-webhook edge function → Supabase (DISABLED 2026-03-01)
- [2026-02-28] Claude.ai ↔ mcp-server edge function ↔ RPC functions ↔ Postgres
- [2026-02-28] Single-user bearer token auth (MCP_SECRET env var)
- [2026-03-03] PWA fallback at docs/pwa/ — vanilla JS, direct PostgREST calls, GitHub Pages
- [2026-02-28] Primary interface: Claude.ai project with MCP connector
- [2026-02-28] Template: ACC MCP server pattern (simplified — no multi-tenant, no OAuth)

## Key Decisions
- [2026-02-27] Mesocycle-based periodisation model with auto-progression
- [2026-02-27] Superset groups tracked in notes field (e.g. "Superset A", "Superset B1/B2")
- [2026-02-27] Running schema designed for Garmin Connect data with external_id for dedup
- [2026-02-28] Custom MCP > generic Supabase MCP — purpose-built tools, no raw SQL
- [2026-02-28] Claude.ai project instructions replace GitHub persona files (reliability issues)
- [2026-02-28] BW exercises: NULL target_weight_kg (not 0)
- [2026-03-01] Claude.ai Skills for structured workflows — MCP = data, Skills = orchestration. Separate skills per flow (not combined)
- [2026-03-01] Muscle soreness stored as per-muscle-group JSONB (not single integer)
- [2026-03-01] Pre-run readiness: log_run_readiness creates manual stub, Garmin sync merges by date via COALESCE
- [2026-03-01] /analyze framework: 5 personal truths (readiness formula, recovery profile, interference pattern, fatigue threshold, progression trajectory)
- [2026-03-01] /analyze skill deferred — dataset too thin (2/19 subjective readiness, 1/19 RPE). Need 4-6 weeks of skill usage first
- [2026-03-01] BB morning is best available readiness predictor (BB >= 89 → 5,137 avg vol; BB <= 72 → 2,929). Workouts cost ~14 BB overnight

## Current State
- [2026-03-06] Active mesocycle: "Hybrid Block V2" (id: 2939aa79-4908-4747-9e67-02a31ba9641d), starts 2026-03-09, ends 2026-04-19
- [2026-03-06] 3 goals: Bench 110kg 1RM (0cd535c5), Pull-ups 16 reps (f4a746a0), 5K 24:30 (3abfda50)
- [2026-03-06] Long-term goals: Bench 150kg, 20 pull-ups, 5K sub-20:00
- [2026-03-06] MCP server: 31 tools deployed (2 new: get_weekly_run_targets, save_weekly_run_targets). Deploy requires --no-verify-jwt
- [2026-03-06] Schema V2: target_rpe + rest_seconds on weekly_targets, weight_added_kg on workout_sets, weekly_run_targets table
- [2026-03-06] 4 gym days: Upper A (Mon), Lower A (Wed), Upper B (Fri), Lower B (Sat)
- [2026-03-06] DUP bench: Heavy Mon (3-5 reps), Volume Fri (8-10 reps)
- [2026-03-06] Week 5 = deload, Week 6 = test (bench 1RM + pull-up max + 5K TT)
- [2026-02-28] MCP server deployed + connected to Claude.ai (no auth on /mcp endpoint, forced Accept header)
- [2026-03-01] Garmin run sync live: 19 runs synced, run_type classified manually via Claude.ai
- [2026-02-28] Strava webhook DISABLED (subscription 332688 pending deletion)
- [2026-02-28] DB constraints: sleep_quality/energy_level/rating are 1-5, pump_quality 1-5, joint_discomfort 0-5
- [2026-03-01] Readiness columns on workouts + run_sessions: sleep_quality, energy_level, muscle_soreness (JSONB)
- [2026-03-01] Garmin Connect sync pipeline: garmin-sync edge function + 4 MCP tools + 8 RPC functions + 3 tables
- [2026-03-01] Garmin tables: garmin_tokens, garmin_daily_summaries, garmin_sync_log
- [2026-03-01] Hybrid auth: garth (Python, local, 1x/year) for OAuth tokens → Deno edge function for API calls + token refresh

## Constraints
- [2026-03-05] No shoulder impingement — user corrected this. DB preference is comfort, not injury-driven
- [2026-02-27] No squats or conventional deadlifts
- [2026-03-03] Repo is public (changed from private for GitHub Pages). Only anon key exposed in client JS — RPCs are SECURITY DEFINER
