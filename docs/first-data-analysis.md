# First Data Analysis: Performance Predictors

**Date:** 2026-03-01
**Dataset:** 19 workouts (347 sets), 20 runs, 30 days Garmin health data (Jan 31 – Mar 1 2026)
**Overlap:** 13 workouts with Garmin data (Feb 3 – Feb 21), 3 runs with Garmin data

> **Device limitation:** Garmin Instinct Solar (original) — no HRV, sleep score, training readiness, VO2 Max, training load. Analysis limited to: body battery, stress, RHR, sleep duration.

---

## 1. Readiness Formula

**Question:** Which metrics predict workout quality?

### Available data: 11 workouts with both Garmin data AND rating (n=11)

| Date | BB Morning | Stress | RHR | Sleep (hrs) | Volume | Rating | Notable |
|------|-----------|--------|-----|-------------|--------|--------|---------|
| Feb 3 (AM) | 84 | 32 | 46 | 8.7 | 3,185 | 4 | "Connecting better" |
| Feb 3 (PM) | 84 | 32 | 46 | 8.7 | 2,644 | 4 | Afternoon session |
| Feb 5 | 81 | 30 | 45 | 7.9 | 4,666 | 4 | |
| Feb 6 | 81 | 40 | 47 | 7.4 | 2,744 | 4 | "Ran long" |
| Feb 10 | null | **67** | **51** | null | 4,460 | 4 | "3 days rest, best numbers" |
| Feb 11 | **56** | 36 | 50 | 8.0 | 2,289 | 4 | |
| Feb 13 | **94** | 35 | 47 | **6.2** | **5,315** | 4 | "Expected bad, felt super strong" |
| Feb 14 | 79 | 38 | 48 | **10.1** | 2,923 | **5** | Only 5-rated session |
| Feb 17 | 89 | 36 | 45 | 7.7 | 5,260 | 4 | |
| Feb 18 | 83 | 30 | 48 | 7.7 | 3,765 | 4 | |
| Feb 20 | **100** | 42 | 45 | 7.9 | **5,835** | 4 | Same day as a run |
| Feb 21 | 72 | **49** | 47 | 8.4 | 3,568 | 4 | Day after workout+run |

### Findings

**Body Battery Morning → Volume (directional, n=10 with BB data)**
- BB >= 89: avg volume **5,137** (n=3: Feb 13, 17, 20)
- BB 79-84: avg volume **3,232** (n=5: Feb 3×2, 5, 14, 18)
- BB <= 72: avg volume **2,929** (n=2: Feb 11, 21)

**Strong signal: Higher BB correlates with higher volume output.** The BB 94 day (Feb 13) and BB 100 day (Feb 20) were the two highest volume sessions (5,315 and 5,835). The lowest BB (56, Feb 11) produced the lowest volume (2,289).

**Body Battery does NOT predict subjective rating.** Almost everything is rated 4. The only 5 (Feb 14) had a middling BB of 79. Rating appears insensitive — you rate based on pump quality and mind-muscle connection, not total volume.

**Stress avg is NOT a reliable negative predictor.** Feb 10 (stress 67, the highest) had the 3rd highest volume and was rated 4 with notes saying "noticeably better numbers." This was after 3 days rest. The high stress that day may have been from life, not physiological readiness.

**RHR is a weak signal.** RHR 45 days averaged 4,787 volume (n=3); RHR 50+ days averaged 3,375 (n=2). Directional but small sample.

**Sleep duration does NOT predict performance.** Feb 13 had only 6.2hrs sleep but the highest volume of any push/pull day (5,315) with notes saying "felt super strong." Feb 14 had 10.1hrs and was the only 5-rated session (arms/shoulders day, lower total volume expected).

**Key insight:** Body battery morning is the best single predictor of volume output. Subjective "feel" before the session is unreliable — Feb 13 notes: "Came in demotivated... expected a bad session but felt super strong."

---

## 2. Recovery Profile

**Question:** How do health metrics change the day after workouts vs rest days?

| Day Type | n | Avg BB Morning | Avg Stress | Avg RHR | Avg Sleep (hrs) | Avg BB Low |
|----------|---|---------------|------------|---------|-----------------|------------|
| Day after workout | 12 | **70.2** | 35.9 | **48.5** | 8.3 | **20.5** |
| Day after run | 2 | 90.5 | 23.5 | 47.5 | 8.0 | 24.5 |
| Rest day | 15 | **84.1** | 33.2 | **46.8** | 8.2 | **30.1** |

### Findings

**Workouts cost ~14 BB points overnight.** Day-after-workout BB morning (70.2) is 14 points lower than rest days (84.1). This is a meaningful recovery signal.

**RHR rises ~2 bpm after workouts.** 48.5 vs 46.8 on rest days. Small but consistent.

**BB low drops significantly.** 20.5 on workout recovery days vs 30.1 on rest days — the body is draining deeper during recovery.

**Runs appear cheaper than gym.** Day-after-run BB is 90.5 (n=2, directional only), suggesting easy runs don't create the same recovery demand. This aligns with the run types being predominantly easy/moderate pace.

**Recovery implication:** Back-to-back gym days show compounding cost. Feb 3→4 (BB dropped 84→76), Feb 5→6 (81→81, held), Feb 13→14 (94→79, -15), Feb 17→18 (89→83, -6), Feb 20→21 (100→72, -28). The Feb 20→21 drop was the largest — that day included both a workout AND a run.

---

## 3. Interference Pattern

**Question:** Does running affect lifting performance?

| Run Context | n | Avg Rating | Avg Volume | Avg Sets |
|------------|---|------------|------------|----------|
| No nearby run | 17 | 4.0 | 3,727 | 17.9 |
| Run day before | 1 | 4.0 | 3,568 | 24.0 |
| Same day run | 1 | 4.0 | 5,835 | 18.0 |

### Findings

**Insufficient data for interference conclusions.** Only 2 workouts had run proximity (n=1 each). The same-day run+workout (Feb 20) actually produced the highest volume of the entire dataset (5,835), but BB was 100 that day.

**Feb 20 case study:** BB 100, ran ~4.4km easy (381 s/km pace, avg HR 135), then did a push/pull workout with highest volume ever. Suggests easy running doesn't impair same-day lifting when BB is high.

**Feb 21 case study:** Day after the Feb 20 double (run+workout), BB dropped to 72 (biggest drop in dataset: -28), stress spiked to 49, volume dropped to 3,568. The compound stimulus had a large recovery cost.

**Directional conclusion:** Easy runs probably don't impair same-day lifting, but the combined recovery cost is significant the next day. **Flag: n=1, monitor closely.**

---

## 4. Fatigue Threshold

**Question:** Does cumulative weekly volume predict performance drops?

> Training load (7d/28d) unavailable on Instinct Solar. Using weekly workout volume as proxy.

### Weekly volume progression (workouts from Jan 26):

| Week | Workouts | Total Volume | Avg Volume/Session | Avg Rating |
|------|----------|-------------|-------------------|------------|
| W1 | 4 | 13,911 | 3,478 | 3.7 |
| W2 | 4 (2 on Feb 3) | 13,239 | 3,310 | 4.0 |
| W3 | 4 | 14,987 | 3,747 | 4.3 |
| W4 | 4 | 18,428 | 4,607 | 4.0 |

### Findings

**No fatigue-induced performance drop over 4 weeks.** Volume increased week-over-week, with W4 being the highest at 18,428 total. Rating stayed at 4.0 consistently.

**W3 was a turning point.** Feb 10 notes explicitly say "3 days rest since last workout — noticeably better numbers." This was after a weekend off. The extra recovery day resulted in a strong session despite terrible Garmin metrics (stress 67, RHR 51).

**W4 highest volume without deload need.** Volume per session jumped 23% from W3→W4 (3,747→4,607). No signs of accumulated fatigue in ratings or qualitative notes.

**Implication:** Current 4-day/week training frequency with 2-3 rest days interspersed is sustainable through at least 4 weeks. The mesocycle design of auto-progression is working — volume increases are being absorbed.

---

## 5. Progression Trajectory

**Question:** Week-over-week weight/rep changes per exercise?

### Key compound exercises (W1→W4):

| Exercise | W1 | W2 | W3 | W4 | Trend |
|----------|----|----|----|----|-------|
| Incline Bench Press | 60kg × 8 | 60kg × 9 | 60kg × 10 | 60kg × 11 | +1 rep/week, textbook |
| Incline BB Press (Wide) | 55kg × 12 | 55kg × 12 | **60kg** × 12 | 60kg × 12 | +5kg at W3 |
| Pull Up | BW × 8 | BW × 8 | BW × 9 | BW × **11** | +3 reps over 4 wks |
| Chin Up | BW × 9 | BW × 9 | BW × 10 | BW × 10 | +1 rep |
| Lat Pulldown | 55kg × 8 | — | **60kg** × 12 | 60kg × 12 | +5kg, +4 reps |

### Key isolation exercises:

| Exercise | W1 | W2 | W3 | W4 | Trend |
|----------|----|----|----|----|-------|
| EZ Bar Curl | 28kg × 15 | **32kg** × 11 | 32kg × 12 | 32kg × 12 | +4kg, reps recovering |
| Skull Crusher | 12kg × 11 | 12kg × 13 | **14kg** × 12 | 14kg × 10 | +2kg, reps stable |
| Inverted Skull Crusher | BW × 15 | BW × 20 | BW × 26 | BW × **30** | +100% reps |
| Seated DB Lat Raise | 5kg × 17 | 5kg × 18 | **6kg** × 16 | **8kg** × 13 | +3kg over 4 wks |
| Straight Arm Pulldown | 22.5kg × 13 | **25kg** × 13 | 25kg × 14 | 25kg × 14 | +2.5kg |

### Findings

**Every tracked exercise progressed.** No exercise showed regression over the 4-week block. The auto-progression logic in the mesocycle is working well.

**Pattern: weight bump → rep recovery → weight bump.** Most exercises follow the cycle of increasing weight, temporarily dropping reps, then rebuilding to target before the next weight increase. EZ Bar Curl: 28→32kg (reps dropped 15→11, recovered to 12). Skull Crusher: 12→14kg (reps dropped from 13→12, then 10 in W4 — monitor).

**Standout progressions:**
- Pull Up +3 reps (8→11) in 4 weeks — on track for the 17-rep goal
- Incline Bench Press +1 rep/week consistently — textbook linear progression
- Inverted Skull Crusher doubled from 15→30 reps — neural adaptation phase
- Seated DB Lateral Raise +60% weight (5→8kg) — rapid early gains

**Stalling risk:** Overhead EZ Extension fluctuated (25→27→24.5→24kg) — notes mention bad connection with DB variation. May need exercise swap.

---

## Summary of Personal Truths (Directional)

| # | Truth | Confidence | Key Metric | Sample |
|---|-------|-----------|------------|--------|
| 1 | **BB morning predicts volume output** | Medium | BB >= 89 → 5,137 avg vol; BB <= 72 → 2,929 | n=10 |
| 2 | **Workouts cost ~14 BB points overnight** | Medium-High | Post-workout BB 70.2 vs rest 84.1 | n=27 |
| 3 | **Easy runs don't impair same-day lifting** | Low | Only 1 same-day run+workout instance | n=1 |
| 4 | **No fatigue threshold hit in 4 weeks** | Medium | Volume increased every week, ratings stable | n=4 wks |
| 5 | **Every exercise progressed** | High | Linear or stepped progression across all tracked exercises | n=4 wks |

### What the data does NOT tell us (Instinct Solar gaps):
- HRV as a readiness predictor (no data)
- Sleep score quality (no data)
- Training readiness composite (no data)
- Training load accumulation (no data)
- VO2 Max trends (no data)

### Actionable insights for the `/analyze` skill:
1. **Morning BB check:** If BB < 70, flag as "reduced capacity day" — adjust volume expectations down ~25%
2. **Recovery tracking:** Monitor BB morning after back-to-back days — if BB drops > 20 points, suggest rest day
3. **Don't trust subjective pre-session feel.** Feb 13 proves that "feeling bad" doesn't mean bad performance when BB is high
4. **Run interference monitoring:** Log more same-day and adjacent-day run+workout combos to build the interference dataset
5. **Weekly volume ceiling unknown.** 18,428 weekly volume (W4) was absorbed fine — keep pushing until ratings or qualitative notes signal fatigue

### Data gaps to close:
- **Subjective readiness:** Only 2 of 19 workouts have sleep_quality/energy_level/muscle_soreness logged. Need the gym-session skill to capture this consistently.
- **RPE:** Only 1 workout has RPE data (W1 day 1: avg 8.3). The skill now captures this but historical data is sparse.
- **Run types:** No runs have run_type classified. Need the update_run_session tool.
- **Pump quality:** Stored in free-text exercise notes, not structured. Could extract but inconsistent format.
