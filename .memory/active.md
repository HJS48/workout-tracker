# Active Context

## Current Focus
[2026-03-06] Hybrid Block V2 fully built — schema migrated, MCP server deployed (31 tools), mesocycle created with 6 weeks of gym + run targets populated, skills and project instructions rewritten to be plan-agnostic, PWA enhanced. Pending: zip/upload skills to Claude.ai, re-paste project instructions, push PWA to GitHub Pages.

## Recent Changes
- [2026-03-06] Schema migration: target_rpe, rest_seconds, weight_added_kg, weekly_run_targets table, 8 RPCs
- [2026-03-06] MCP server redeployed: 31 tools (2 new: get_weekly_run_targets, save_weekly_run_targets)
- [2026-03-06] Mesocycle "Hybrid Block V2" created (id: 2939aa79), 4 gym days, March 9 - April 19
- [2026-03-06] 136 gym targets + 18 run targets populated across 6 weeks
- [2026-03-06] 3 goals: Bench 110kg 1RM, Pull-ups 16 reps, 5K 24:30
- [2026-03-06] 4 new exercises: Nordic Hamstring Curl, Pallof Press, Tibialis Raise, Romanian DB Deadlift
- [2026-03-06] Skills rewritten plan-agnostic (gym-session, run-session) — all plan specifics from DB at runtime
- [2026-03-06] Project instructions rewritten plan-agnostic — no block/exercise/weight references
- [2026-03-06] PWA: RPE + rest display, weight_added_kg, deload/test week banners, week number
- [2026-03-06] Reviewer agent caught 6 issues — all fixed (parallel call ordering, field naming, gap detection)
- [2026-03-06] Training plan documented: docs/training-block-v2.md (~680 lines)

## Open Questions
- [ ] Skills need zipping and uploading to Claude.ai
- [ ] Project instructions need re-pasting into Claude.ai
- [ ] PWA changes need git push to deploy to GitHub Pages
- [ ] save_weekly_run_targets MCP tool not in Claude Code tool list (works via direct RPC, Claude.ai MCP connector should see it)
- [ ] pg_cron job 2 still needs updating to /run-sync
- [ ] Strava webhook subscription 332688 not yet deleted

## Next Steps
1. Zip skills/gym-session/ and skills/run-session/, upload to Claude.ai project
2. Copy docs/claude-ai-project-instructions.md into Claude.ai project settings
3. git push to deploy PWA changes to GitHub Pages
4. End-to-end test: start a workout in Claude.ai, verify RPE/rest/targets display
5. First V2 workout: Monday March 9

## Working State
- **MCP server:** 31 tools deployed, verified via get_workout_plan (target_rpe + rest_seconds returned correctly)
- **Mesocycle:** Hybrid Block V2, 4 days (Upper A/Lower A/Upper B/Lower B), weeks 1-6 fully populated
- **PWA:** Updated locally, not yet pushed — docs/pwa/app.js + docs/pwa/style.css
- **Skills:** Plan-agnostic, reviewed and fixed — skills/gym-session/SKILL.md, skills/run-session/SKILL.md
- **Instructions:** Plan-agnostic — docs/claude-ai-project-instructions.md
- **Training plan:** docs/training-block-v2.md (reference doc, not consumed by system)
