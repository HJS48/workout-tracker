# Coaching Skills Design — 2026-03-01

## Overview
Three skills forming a complete coaching loop. Core principle: **no auto-adjustments or assumed thresholds** — only surface insights backed by actual data correlations with sample sizes.

## Skill 1: `/session` — Daily Workout Flow
- Starts with readiness display (BB, sleep, stress, RHR from Garmin)
- Pulls today's plan from mesocycle targets
- **Surfaces stored insights only** — e.g. "BB is 38 today. In your 8 sessions with BB <45, your top-set RPE averaged 0.8 higher than usual." Never invents correlations.
- If no data-backed pattern exists for today's health state, just shows raw numbers and moves on
- Guides through exercises, logs sets, collects feedback (RPE, pump, joint)
- Ends with summary + flags for next session

## Skill 2: `/review` — Weekly Review + Progression + Run Planning (combined)
- Originally 3 separate ideas (weekly review, progression engine, next-run), collapsed into one
- Pulls all workouts, runs, and health trends for the week
- Compares performance vs targets (hit/miss/exceeded)
- Applies progression rules → generates next week's targets
  - RPE <8 all sets → bump weight
  - RPE 9-10 → hold
  - Joint discomfort >2 → flag for swap
  - (Rules TBD with user, these are starting points)
- Suggests next week's runs (types + paces) based on mesocycle plan + recent run data
- Saves updated weekly targets via save_weekly_targets RPC

## Skill 3: `/analyze` — Periodic Correlation Analysis
- Runs periodically (monthly, or on-demand)
- Pulls joined dataset: all workouts + same-day health data
- Claude analyzes for correlations between health metrics and performance metrics
- Example findings:
  - "When BB <45, bench press volume drops ~12% (n=8)"
  - "Runs on <6h sleep days average 8% slower pace (n=5)"
  - "No significant correlation found between stress_avg and workout rating (n=13)"
- Stores findings in `health_performance_insights` table (structured)
- `/session` reads from this table to surface relevant insights

## Architecture

```
/analyze (periodic)
    → get_workout_health_correlation RPC (joins workouts + garmin_daily_summaries)
    → Claude identifies patterns with statistical rigor
    → Writes to health_performance_insights table

/session (every workout)
    → get_readiness (today's health)
    → Reads health_performance_insights for matching conditions
    → Shows data-backed observations only
    → Normal workout flow (plan → log sets → feedback → end)

/review (weekly)
    → get_week_summary + get_health_trends + get_run_sessions
    → Performance vs targets analysis
    → Progression rules → save_weekly_targets
    → Run planning for next week
```

## What Needs Building

### Database
1. **New RPC: `get_workout_health_correlation`** — joins workouts (sets, RPE, volume, rating) with garmin_daily_summaries (BB, sleep, stress, RHR) on date. Returns per-session rows with both performance and health metrics.
2. **New table: `health_performance_insights`** — stores computed findings
   - Fields TBD but likely: metric_pair, direction, magnitude, sample_size, confidence, summary_text, created_at
3. Run data also needs joining — correlate run pace/HR with health metrics

### Skills (Claude Code skills in ~/.claude/skills/)
4. `/session` skill definition
5. `/review` skill definition
6. `/analyze` skill definition

### Data Available Now
- 19 workouts (347 sets) from Jan 2025 – Feb 2026
- 13 workouts overlap with 30-day Garmin health data (2026-01-30 to 2026-02-21)
- 19 Garmin runs in the health data range
- Enough for directional patterns, not statistically bulletproof yet
- Gets stronger every week with new data

## Key Design Decisions
- **No hardcoded thresholds** — "BB <40 = bad" is an assumption. Let the data show what actually impacts performance for THIS user.
- **Sample sizes always shown** — "from 8 sessions" not just "when BB is low"
- **Insights stored, not computed live** — `/analyze` writes, `/session` reads. Separation of analysis from presentation.
- **Run type auto-classification** considered — HR zone distribution could suggest type (>80% zone 1-2 = easy, zone 4-5 = tempo/interval). Could be a post-sync hook rather than a skill.
