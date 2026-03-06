/**
 * Garmin Connect Sync — Edge Function
 *
 * Syncs health data from Garmin Connect API using OAuth1→OAuth2 token flow.
 * Auth handled by garth (Python, local) — this function uses stored tokens.
 *
 * Routes:
 *   GET  /garmin-sync            — health check
 *   POST /garmin-sync/daily      — sync today's daily summary (cron + on-demand)
 *   POST /garmin-sync/backfill   — sync a date range of daily summaries
 *   POST /garmin-sync/activities — backfill TE/VO2 on run_sessions (legacy)
 *   POST /garmin-sync/run-sync   — sync runs from Garmin (primary run data source)
 */

// RUN DATA SOURCE: GARMIN (switched 2026-03-01, was Strava)
// To switch back to Strava: re-enable webhook subscription (see strava-webhook/index.ts header),
// disable pg_cron job ID 2, remove run-sync call from MCP sync_garmin_data handler.

import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://xwfshemzhunaxbzjgata.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const GARMIN_SYNC_SECRET = Deno.env.get('GARMIN_SYNC_SECRET')!

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const GARMIN_CONNECT_BASE = 'https://connectapi.garmin.com'

// =============================================================================
// AUTH
// =============================================================================

function checkAuth(c: { req: { header: (name: string) => string | undefined } }): boolean {
  // Check x-garmin-secret header first, then fall back to Authorization bearer
  const secret = c.req.header('x-garmin-secret')
  if (secret === GARMIN_SYNC_SECRET) return true
  const auth = c.req.header('Authorization')
  if (!auth) return false
  return auth.replace('Bearer ', '') === GARMIN_SYNC_SECRET
}

// =============================================================================
// TOKEN MANAGEMENT
// =============================================================================

interface GarminTokens {
  display_name: string
  oauth1_token: string
  oauth1_token_secret: string
  oauth2_access_token: string
  oauth2_expires_at: number
  consumer_key: string
  consumer_secret: string
}

/**
 * Get a valid OAuth2 access token, refreshing if needed.
 *
 * Garmin's OAuth2 tokens expire hourly. Refresh uses OAuth1 credentials
 * to exchange for a new OAuth2 token via Garmin's SSO endpoint.
 */
async function getValidAccessToken(): Promise<{ token: string; displayName: string }> {
  const { data: tokens } = await supabase.rpc('get_garmin_tokens') as { data: GarminTokens | null }
  if (!tokens) throw new Error('No Garmin tokens found. Run garth locally to authenticate.')

  const nowSec = Math.floor(Date.now() / 1000)

  // If token is valid for more than 5 minutes, use it
  if (tokens.oauth2_expires_at > nowSec + 300) {
    return { token: tokens.oauth2_access_token, displayName: tokens.display_name }
  }

  // Refresh OAuth2 token using OAuth1 credentials
  console.log('[garmin] Refreshing OAuth2 token via OAuth1 exchange...')

  const resp = await fetch('https://connectapi.garmin.com/oauth-service/oauth/exchange/user/2.0', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: await buildOAuth1Header(tokens, 'POST',
        'https://connectapi.garmin.com/oauth-service/oauth/exchange/user/2.0'),
    },
  })

  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`OAuth2 refresh failed: ${resp.status} ${errText}`)
  }

  const refreshed = await resp.json()

  // Save new OAuth2 token
  await supabase.rpc('update_garmin_oauth2_token', {
    p_oauth2_access_token: refreshed.access_token,
    p_oauth2_expires_at: nowSec + (refreshed.expires_in || 3600),
  })

  // Log the refresh
  await supabase.from('garmin_sync_log').insert({
    sync_type: 'token_refresh',
    status: 'success',
  })

  return { token: refreshed.access_token, displayName: tokens.display_name }
}

/**
 * Build OAuth1 Authorization header for token exchange.
 * Uses HMAC-SHA1 signature method per OAuth 1.0a spec.
 */
async function buildOAuth1Header(tokens: GarminTokens, method: string, url: string): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const nonce = crypto.randomUUID().replace(/-/g, '')

  const params: Record<string, string> = {
    oauth_consumer_key: tokens.consumer_key,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: tokens.oauth1_token,
    oauth_version: '1.0',
  }

  // Build signature base string
  const sortedParams = Object.keys(params).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&')

  const baseString = [
    method.toUpperCase(),
    encodeURIComponent(url),
    encodeURIComponent(sortedParams),
  ].join('&')

  // Sign with consumer_secret & oauth1_token_secret
  const signingKey = `${encodeURIComponent(tokens.consumer_secret)}&${encodeURIComponent(tokens.oauth1_token_secret)}`

  const signature = await hmacSha1(signingKey, baseString)
  params.oauth_signature = signature

  const header = 'OAuth ' + Object.keys(params).sort()
    .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(params[k])}"`)
    .join(', ')

  return header
}

/** HMAC-SHA1 signature (Web Crypto API) */
async function hmacSha1(key: string, data: string): Promise<string> {
  const encoder = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey(
    'raw', encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-1' },
    false, ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data))
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
}

// =============================================================================
// GARMIN CONNECT API CALLS
// =============================================================================

async function garminGet(path: string, accessToken: string): Promise<any> {
  const resp = await fetch(`${GARMIN_CONNECT_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'WorkoutTracker/1.0',
    },
  })

  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`Garmin API ${path}: ${resp.status} ${errText}`)
  }

  return await resp.json()
}

/** Fetch all daily health endpoints for a given date */
async function fetchDailyData(date: string, accessToken: string, displayName: string) {
  // Note: HRV and Training Readiness excluded — not supported on Instinct Solar (original).
  // These endpoints are kept commented for future device upgrades.
  const endpoints: Record<string, string> = {
    sleep: `/wellness-service/wellness/dailySleepData/${displayName}?date=${date}&nonSleepBufferMinutes=60`,
    // hrv: `/hrv-service/hrv/${date}`,
    bodyBattery: `/wellness-service/wellness/bodyBattery/reports/daily?startDate=${date}&endDate=${date}`,
    // trainingReadiness: `/metrics-service/metrics/trainingreadiness/${date}`,
    trainingStatus: `/metrics-service/metrics/trainingstatus/aggregated/${date}`,
    stress: `/wellness-service/wellness/dailyStress/${date}`,
    dailySummary: `/usersummary-service/usersummary/daily/${displayName}?calendarDate=${date}`,
    respiration: `/wellness-service/wellness/daily/respiration/${date}`,
  }

  const results: Record<string, { data: any; error: string | null }> = {}

  const fetches = Object.entries(endpoints).map(async ([key, path]) => {
    try {
      const data = await garminGet(path, accessToken)
      results[key] = { data, error: null }
    } catch (e) {
      console.error(`[garmin] Failed to fetch ${key}:`, e)
      results[key] = { data: null, error: (e as Error).message }
    }
  })

  await Promise.allSettled(fetches)
  return results
}

// =============================================================================
// DATA MAPPING
// =============================================================================

function mapDailyData(date: string, raw: Record<string, { data: any; error: string | null }>) {
  const params: Record<string, unknown> = { p_summary_date: date }

  // Sleep
  if (raw.sleep?.data) {
    const s = raw.sleep.data
    params.p_sleep_duration_s = s.sleepTimeSeconds ?? s.dailySleepDTO?.sleepTimeSeconds ?? null
    params.p_sleep_score = s.sleepScores?.overall?.value ?? s.sleepScores?.totalScore?.value ?? null
    params.p_sleep_deep_s = s.deepSleepSeconds ?? s.dailySleepDTO?.deepSleepSeconds ?? null
    params.p_sleep_light_s = s.lightSleepSeconds ?? s.dailySleepDTO?.lightSleepSeconds ?? null
    params.p_sleep_rem_s = s.remSleepSeconds ?? s.dailySleepDTO?.remSleepSeconds ?? null
    params.p_sleep_awake_s = s.awakeSleepSeconds ?? s.dailySleepDTO?.awakeSleepSeconds ?? null
    params.p_measurable_asleep_s = s.dailySleepDTO?.measurableAsleepDuration ?? null
    params.p_measurable_awake_s = s.dailySleepDTO?.measurableAwakeDuration ?? null
    params.p_raw_sleep = s
  }

  // HRV
  if (raw.hrv?.data) {
    const h = raw.hrv.data
    params.p_hrv_weekly_avg = h.weeklyAvg ?? h.hrvSummary?.weeklyAvg ?? null
    params.p_hrv_last_night = h.lastNightAvg ?? h.hrvSummary?.lastNightAvg ?? h.lastNight5MinHigh ?? null
    params.p_hrv_status = h.status ?? h.hrvSummary?.status ?? null
    params.p_raw_hrv = h
  }

  // Body Battery
  if (raw.bodyBattery?.data) {
    const bb = raw.bodyBattery.data
    // API returns an array of date entries
    const dayData = Array.isArray(bb) ? bb[0] : bb
    if (dayData) {
      // Fix: use bodyBatteryAtWakeTime (actual level at wake), NOT charged (amount gained during sleep)
      params.p_body_battery_morning = dayData.bodyBatteryAtWakeTime ?? findMorningBB(dayData)
      // highestValue/lowestValue = actual peak/trough BB levels
      // chargedValue/drainedValue = amount gained/lost (NOT the level) — don't use for high/low
      params.p_body_battery_high = dayData.highestValue ?? dayData.maxValue ?? null
      params.p_body_battery_low = dayData.lowestValue ?? dayData.minValue ?? null
      params.p_body_battery_during_sleep = dayData.bodyBatteryDuringSleep ?? dayData.charged ?? null
      params.p_raw_body_battery = bb
    }
  }

  // Training Readiness
  if (raw.trainingReadiness?.data) {
    const tr = raw.trainingReadiness.data
    params.p_training_readiness_score = tr.score ?? tr.trainingReadinessScore ?? null
    params.p_training_readiness_level = tr.level ?? tr.trainingReadinessLevel ?? null
    params.p_training_readiness_hrv_score = tr.hrvScore ?? tr.components?.hrv?.score ?? null
    params.p_training_readiness_sleep_score = tr.sleepScore ?? tr.components?.sleep?.score ?? null
    params.p_training_readiness_recovery_score = tr.recoveryScore ?? tr.components?.recovery?.score ?? null
    params.p_training_readiness_activity_score = tr.activityScore ?? tr.components?.activity?.score ?? null
    params.p_raw_training_readiness = tr
  }

  // Training Status
  if (raw.trainingStatus?.data) {
    const ts = raw.trainingStatus.data
    params.p_training_status = ts.trainingStatusLabel ?? ts.currentDayTrainingStatus ?? null
    params.p_training_load_7d = ts.weeklyTrainingLoad ?? ts.shortTermLoad ?? null
    params.p_training_load_28d = ts.monthlyTrainingLoad ?? ts.longTermLoad ?? null
    params.p_vo2_max = ts.vo2MaxPreciseValue ?? ts.mostRecentVO2Max ?? ts.vo2Max ?? null
    params.p_raw_training_status = ts
  }

  // Stress
  if (raw.stress?.data) {
    const st = raw.stress.data
    params.p_stress_avg = st.overallStressLevel ?? st.avgStressLevel ?? null
    params.p_stress_max = st.maxStressLevel ?? null
    params.p_stress_high_s = st.highStressDuration ?? null
    params.p_stress_medium_s = st.mediumStressDuration ?? null
    params.p_stress_low_s = st.lowStressDuration ?? null
    params.p_stress_rest_s = st.restStressDuration ?? null
    params.p_raw_stress = st
  }

  // Daily Summary — richest source for Instinct Solar
  if (raw.dailySummary?.data) {
    const ds = raw.dailySummary.data
    params.p_resting_heart_rate = ds.restingHeartRate ?? null
    params.p_min_heart_rate = ds.minHeartRate ?? null
    params.p_seven_day_avg_rhr = ds.lastSevenDaysAvgRestingHeartRate ?? null
    params.p_total_steps = ds.totalSteps ?? null
    params.p_active_seconds = ds.activeSeconds ?? ds.highlyActiveSeconds ?? null
    params.p_sedentary_seconds = ds.sedentarySeconds ?? null

    // Body battery high/low from daily summary (more reliable than body battery endpoint)
    if (!params.p_body_battery_high) {
      params.p_body_battery_high = ds.bodyBatteryHighestValue ?? null
    }
    if (!params.p_body_battery_low) {
      params.p_body_battery_low = ds.bodyBatteryLowestValue ?? null
    }
    // Fallback: morning BB from daily summary (prefer bodyBatteryAtWakeTime over charged)
    if (!params.p_body_battery_morning) {
      params.p_body_battery_morning = ds.bodyBatteryAtWakeTime ?? null
    }

    // Stress durations from daily summary (fallback if stress endpoint missed them)
    if (!params.p_stress_avg) {
      params.p_stress_avg = ds.averageStressLevel ?? null
    }
    if (!params.p_stress_max) {
      params.p_stress_max = ds.maxStressLevel ?? null
    }
    if (!params.p_stress_high_s) {
      params.p_stress_high_s = ds.highStressDuration ?? null
    }
    if (!params.p_stress_medium_s) {
      params.p_stress_medium_s = ds.mediumStressDuration ?? null
    }
    if (!params.p_stress_low_s) {
      params.p_stress_low_s = ds.lowStressDuration ?? null
    }
    if (!params.p_stress_rest_s) {
      params.p_stress_rest_s = ds.restStressDuration ?? null
    }

    params.p_raw_daily_summary = ds
  }

  // Respiration
  if (raw.respiration?.data) {
    const r = raw.respiration.data
    params.p_avg_respiration_rate = r.avgWakingRespirationValue ?? r.avgSleepRespirationValue ?? null
    params.p_raw_respiration = r
  }

  return params
}

/** Try to find morning Body Battery value from time series */
function findMorningBB(dayData: any): number | null {
  // Note: dayData.charged is amount GAINED during sleep, NOT wake level — skip it
  if (dayData.startingValue != null) return dayData.startingValue
  // If there's a body battery list, find first value around 6-9am
  if (Array.isArray(dayData.bodyBatteryValuesArray)) {
    const morning = dayData.bodyBatteryValuesArray.find((v: any) => {
      if (!v[0]) return false
      const hour = new Date(v[0]).getHours()
      return hour >= 5 && hour <= 9
    })
    if (morning) return morning[1]
    // Fallback: first value of the day
    return dayData.bodyBatteryValuesArray[0]?.[1] ?? null
  }
  return null
}

// =============================================================================
// ACTIVITY MATCHING — Backfill TE/VO2 on run_sessions
// =============================================================================

async function syncActivityMetrics(accessToken: string, displayName: string) {
  // Find run_sessions missing Garmin metrics
  const { data: sessions, error } = await supabase
    .from('run_sessions')
    .select('id, date, distance_m, duration_s')
    .is('training_effect_aerobic', null)
    .eq('source', 'strava')
    .order('date', { ascending: false })
    .limit(20)

  if (error) throw new Error(`Query run_sessions: ${error.message}`)
  if (!sessions || sessions.length === 0) return { matched: 0, message: 'No sessions need backfill' }

  // Get date range for Garmin activity search
  const dates = sessions.map(s => s.date).sort()
  const startDate = dates[0]
  const endDate = dates[dates.length - 1]

  // Fetch Garmin activities (API uses start/limit pagination, not date filters)
  const activities = await garminGet(
    `/activitylist-service/activities/search/activities?start=0&limit=50`,
    accessToken,
  )

  if (!Array.isArray(activities) || activities.length === 0) {
    return { matched: 0, message: 'No Garmin activities found for date range' }
  }

  let matched = 0

  for (const session of sessions) {
    // Match by date + distance (within 5% tolerance)
    const match = activities.find((a: any) => {
      // Garmin startTimeLocal format: "2026-02-28 17:36:57"
      const actDate = a.startTimeLocal
        ? a.startTimeLocal.split(' ')[0]
        : null
      if (actDate !== session.date) return false

      // Only match running activities
      if (a.activityType?.typeKey !== 'running') return false

      const distDiff = Math.abs((a.distance || 0) - (session.distance_m || 0))
      const tolerance = (session.distance_m || 0) * 0.05
      return distDiff <= tolerance
    })

    if (match) {
      // Get detailed activity data for TE/VO2
      let detail
      try {
        detail = await garminGet(
          `/activity-service/activity/${match.activityId}`,
          accessToken,
        )
      } catch {
        continue
      }

      const te_aerobic = detail.aerobicTrainingEffect ?? detail.summaryDTO?.aerobicTrainingEffect ?? null
      const te_anaerobic = detail.anaerobicTrainingEffect ?? detail.summaryDTO?.anaerobicTrainingEffect ?? null
      const vo2max = detail.vO2MaxValue ?? detail.summaryDTO?.vO2MaxValue ?? null

      if (te_aerobic != null || te_anaerobic != null || vo2max != null) {
        await supabase.rpc('update_run_session_garmin_metrics', {
          p_run_session_id: session.id,
          p_training_effect_aerobic: te_aerobic,
          p_training_effect_anaerobic: te_anaerobic,
          p_vo2_max_estimate: vo2max,
        })
        matched++
      }
    }
  }

  return { matched, total_sessions: sessions.length, total_activities: activities.length }
}

// =============================================================================
// RUN SYNC — Garmin as primary run data source
// =============================================================================

/**
 * Map Garmin activity search result + detail → upsert_run_session RPC params.
 * run_type is left null — classified manually via Claude.ai after sync.
 */
function mapGarminRunToSession(
  search: any,
  detail: any,
): Record<string, unknown> {
  const summary = detail.summaryDTO || detail || {}

  // Parse start time
  const startTimeLocal = search.startTimeLocal // "2026-02-28 17:36:57"
  const startDate = startTimeLocal ? startTimeLocal.split(' ')[0] : null
  const startedAt = search.startTimeGMT
    ? new Date(search.startTimeGMT).toISOString()
    : null

  // Duration
  const durationS = search.duration || summary.elapsedDuration || null
  const movingDurationS = summary.movingDuration || search.movingDuration || null

  // Distance in meters
  const distanceM = search.distance || summary.distance || null

  // Pace: compute from distance and duration
  let avgPace: number | null = null
  if (distanceM && durationS && distanceM > 0) {
    avgPace = Math.round((durationS / (distanceM / 1000)) * 100) / 100
  }

  // Ended at
  let endedAt: string | null = null
  if (startedAt && durationS) {
    endedAt = new Date(new Date(startedAt).getTime() + durationS * 1000).toISOString()
  }

  // Fastest splits from search (field names: fastestSplit_1000, _1609, _5000)
  const fastest1km = search.fastestSplit_1000 ?? null
  const fastestMile = search.fastestSplit_1609 ?? null
  const fastest5km = search.fastestSplit_5000 ?? null

  // Stride length: search.avgStrideLength is in cm, convert to meters
  const strideCm = search.avgStrideLength ?? summary.strideLength ?? null
  const strideM = strideCm != null ? Math.round((strideCm / 100) * 100) / 100 : null

  // Max cadence: in search or summaryDTO (already integer)
  const maxCadenceRaw = search.maxRunningCadenceInStepsPerMinute
    ?? summary.maxRunCadence ?? null

  // Temperature: prefer summaryDTO.averageTemperature, fall back to search avg
  const avgTemp = summary.averageTemperature
    ?? (search.maxTemperature != null
      ? Math.round(((search.maxTemperature + (search.minTemperature ?? search.maxTemperature)) / 2) * 10) / 10
      : null)

  return {
    p_external_id: String(search.activityId),
    p_source: 'garmin',
    p_date: startDate,
    p_started_at: startedAt,
    p_ended_at: endedAt,
    p_run_type: null, // classified manually later
    p_distance_m: distanceM,
    p_duration_s: durationS,
    p_avg_pace_s_per_km: avgPace,
    p_avg_heart_rate: search.averageHR || summary.averageHR || null,
    p_max_heart_rate: search.maxHR || summary.maxHR || null,
    p_min_heart_rate: summary.minHR ?? null,
    p_avg_cadence: search.averageRunningCadenceInStepsPerMinute != null
      ? Math.round(search.averageRunningCadenceInStepsPerMinute)
      : (summary.averageRunningCadenceInStepsPerMinute != null
        ? Math.round(summary.averageRunningCadenceInStepsPerMinute) : null),
    p_max_cadence: maxCadenceRaw != null ? Math.round(maxCadenceRaw) : null,
    p_elevation_gain_m: search.elevationGain || summary.elevationGain || null,
    p_elevation_loss_m: search.elevationLoss || summary.elevationLoss || null,
    p_calories: search.calories || summary.calories || null,
    p_training_effect_aerobic: detail.aerobicTrainingEffect
      ?? summary.aerobicTrainingEffect ?? null,
    p_training_effect_anaerobic: detail.anaerobicTrainingEffect
      ?? summary.anaerobicTrainingEffect ?? null,
    p_vo2_max_estimate: detail.vO2MaxValue ?? summary.vO2MaxValue ?? null,
    p_avg_stride_length_m: strideM,
    p_steps: search.steps || summary.steps || null,
    p_avg_temperature_c: avgTemp,
    p_moving_duration_s: movingDurationS,
    p_fastest_1km_s: fastest1km,
    p_fastest_mile_s: fastestMile,
    p_fastest_5km_s: fastest5km,
    p_raw_garmin: { search, detail },
  }
}

/** Map Garmin splits/laps → run_laps format */
function mapGarminSplits(splits: any): any[] | null {
  if (!splits) return null

  // Garmin splits response may have different structures
  const lapList = splits.lapDTOs || splits.splitDTOs || splits
  if (!Array.isArray(lapList) || lapList.length === 0) return null

  return lapList.map((lap: any, i: number) => ({
    lap_number: lap.lapNumber ?? (i + 1),
    distance_m: lap.distance ?? null,
    duration_s: lap.duration ?? lap.elapsedDuration ?? null,
    avg_pace_s_per_km: lap.distance && lap.duration && lap.distance > 0
      ? Math.round((lap.duration / (lap.distance / 1000)) * 100) / 100
      : null,
    avg_heart_rate: lap.averageHR ?? null,
    max_heart_rate: lap.maxHR ?? null,
    avg_cadence: lap.averageRunningCadenceInStepsPerMinute != null
      ? Math.round(lap.averageRunningCadenceInStepsPerMinute) : null,
    elevation_gain_m: lap.elevationGain ?? null,
    elevation_loss_m: lap.elevationLoss ?? null,
    avg_stride_length_m: lap.averageStrideLength ?? null,
    max_cadence: lap.maxRunningCadenceInStepsPerMinute != null
      ? Math.round(lap.maxRunningCadenceInStepsPerMinute) : null,
  }))
}

/** Map Garmin HR zone durations → run_hr_zones format */
function mapGarminHrZones(search: any): any[] | null {
  // Garmin search results include hrTimeInZone_1 through _5 (seconds in each zone)
  // Zone boundaries: hrZone1Floor..hrZone5Ceiling (unconfirmed field names — extract from raw_garmin)
  const zones: any[] = []

  for (let i = 1; i <= 5; i++) {
    const duration = search[`hrTimeInZone_${i}`] ?? search[`timeInHRZone${i}`]
    if (duration != null) {
      zones.push({
        zone_number: i,
        duration_s: duration,
        // HR boundaries — try known field names, fall back to null
        min_hr: search[`hrZone${i}Floor`] ?? search[`hrZone${i}Lower`] ?? null,
        max_hr: search[`hrZone${i}Ceiling`] ?? search[`hrZone${i}Upper`]
          ?? (i < 5 ? (search[`hrZone${i + 1}Floor`] ?? null) : null),
      })
    }
  }

  return zones.length > 0 ? zones : null
}

/**
 * Sync recent running activities from Garmin Connect.
 * Fetches activity list, filters to running, skips already-synced, fetches detail + splits per run.
 */
async function syncGarminRuns(accessToken: string, _displayName: string) {
  // Fetch recent activities
  const activities = await garminGet(
    '/activitylist-service/activities/search/activities?start=0&limit=20',
    accessToken,
  )

  if (!Array.isArray(activities) || activities.length === 0) {
    return { synced: 0, skipped: 0, message: 'No Garmin activities found' }
  }

  // Filter to running activities only
  const runActivities = activities.filter(
    (a: any) => a.activityType?.typeKey === 'running',
  )

  if (runActivities.length === 0) {
    return { synced: 0, skipped: 0, total_activities: activities.length, message: 'No running activities found' }
  }

  // Check which are already synced
  const activityIds = runActivities.map((a: any) => String(a.activityId))
  const { data: existing } = await supabase
    .from('run_sessions')
    .select('external_id')
    .eq('source', 'garmin')
    .in('external_id', activityIds)

  const existingIds = new Set((existing || []).map((r: any) => r.external_id))

  let synced = 0
  let skipped = 0
  const errors: string[] = []

  for (const activity of runActivities) {
    const actId = String(activity.activityId)

    if (existingIds.has(actId)) {
      skipped++
      continue
    }

    try {
      // Fetch detail (TE, VO2, fastest splits, temperature)
      const detail = await garminGet(
        `/activity-service/activity/${activity.activityId}`,
        accessToken,
      )

      // Fetch splits/laps (may not exist for all activities)
      let splits = null
      try {
        splits = await garminGet(
          `/activity-service/activity/${activity.activityId}/splits`,
          accessToken,
        )
      } catch {
        // Splits endpoint may not exist — fall back gracefully
        console.log(`[garmin] No splits for activity ${actId}`)
      }

      // Map to RPC params
      const params = mapGarminRunToSession(activity, detail)
      params.p_laps = mapGarminSplits(splits)
      params.p_hr_zones = mapGarminHrZones(activity)

      // Upsert
      const { error } = await supabase.rpc('upsert_run_session', params)
      if (error) {
        errors.push(`Activity ${actId}: ${error.message}`)
        continue
      }

      synced++

      // Rate limit between detail fetches
      await new Promise(r => setTimeout(r, 500))
    } catch (e) {
      errors.push(`Activity ${actId}: ${(e as Error).message}`)
    }
  }

  return {
    synced,
    skipped,
    total_running: runActivities.length,
    total_activities: activities.length,
    ...(errors.length > 0 ? { errors } : {}),
  }
}

// =============================================================================
// ROUTES
// =============================================================================

const app = new Hono()

// Health check
app.get('/garmin-sync', (c) => {
  return c.json({
    name: 'Garmin Connect Sync',
    version: '1.0.0',
    status: 'healthy',
    routes: ['GET /', 'POST /daily', 'POST /backfill', 'POST /activities', 'POST /run-sync'],
  })
})

// Daily sync — today's health data
app.post('/garmin-sync/daily', async (c) => {
  if (!checkAuth(c)) return c.json({ error: 'Unauthorized' }, 401)

  const startTime = Date.now()
  const body = await c.req.json().catch(() => ({}))
  const date = body.date || new Date().toISOString().split('T')[0]

  try {
    const { token, displayName } = await getValidAccessToken()
    const raw = await fetchDailyData(date, token, displayName)

    // Count successes and failures
    const succeeded = Object.entries(raw).filter(([, v]) => v.data != null).map(([k]) => k)
    const failed = Object.entries(raw).filter(([, v]) => v.error != null).map(([k]) => k)

    if (succeeded.length === 0) {
      await supabase.from('garmin_sync_log').insert({
        sync_type: 'daily_summary',
        sync_date: date,
        status: 'error',
        error_message: 'All endpoints failed',
        duration_ms: Date.now() - startTime,
        details: { failed, errors: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v.error])) },
      })
      return c.json({ status: 'error', message: 'All endpoints failed', failed }, 500)
    }

    // Map and upsert
    const params = mapDailyData(date, raw)
    const { error } = await supabase.rpc('upsert_garmin_daily_summary', params)
    if (error) throw new Error(`upsert_garmin_daily_summary: ${error.message}`)

    const status = failed.length === 0 ? 'success' : 'partial'

    await supabase.from('garmin_sync_log').insert({
      sync_type: 'daily_summary',
      sync_date: date,
      status,
      duration_ms: Date.now() - startTime,
      details: { succeeded, failed },
    })

    return c.json({ status, date, succeeded, failed })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error'
    console.error(`[garmin-sync] Daily sync error:`, err)

    await supabase.from('garmin_sync_log').insert({
      sync_type: 'daily_summary',
      sync_date: date,
      status: 'error',
      error_message: errMsg,
      duration_ms: Date.now() - startTime,
    }).catch(() => {})

    return c.json({ status: 'error', message: errMsg }, 500)
  }
})

// Backfill — sync a range of dates
app.post('/garmin-sync/backfill', async (c) => {
  if (!checkAuth(c)) return c.json({ error: 'Unauthorized' }, 401)

  const startTime = Date.now()
  const body = await c.req.json().catch(() => ({}))
  const days = body.days || 30
  const endDate = body.end_date || new Date().toISOString().split('T')[0]

  try {
    const { token, displayName } = await getValidAccessToken()

    const results: { date: string; status: string }[] = []

    for (let i = 0; i < days; i++) {
      const date = new Date(endDate)
      date.setDate(date.getDate() - i)
      const dateStr = date.toISOString().split('T')[0]

      try {
        const raw = await fetchDailyData(dateStr, token, displayName)
        const succeeded = Object.entries(raw).filter(([, v]) => v.data != null).map(([k]) => k)

        if (succeeded.length > 0) {
          const params = mapDailyData(dateStr, raw)
          await supabase.rpc('upsert_garmin_daily_summary', params)
          results.push({ date: dateStr, status: succeeded.length === 8 ? 'success' : 'partial' })
        } else {
          results.push({ date: dateStr, status: 'no_data' })
        }
      } catch (e) {
        results.push({ date: dateStr, status: 'error' })
      }

      // Rate limit: 1 second between dates
      if (i < days - 1) await new Promise(r => setTimeout(r, 1000))
    }

    const syncedCount = results.filter(r => r.status !== 'error' && r.status !== 'no_data').length

    await supabase.from('garmin_sync_log').insert({
      sync_type: 'daily_summary',
      status: syncedCount > 0 ? 'success' : 'error',
      duration_ms: Date.now() - startTime,
      details: { type: 'backfill', days, synced: syncedCount, results },
    })

    return c.json({ status: 'ok', days_requested: days, days_synced: syncedCount, results })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error'
    console.error(`[garmin-sync] Backfill error:`, err)
    return c.json({ status: 'error', message: errMsg }, 500)
  }
})

// Activity backfill — match Garmin activities to run_sessions for TE/VO2
app.post('/garmin-sync/activities', async (c) => {
  if (!checkAuth(c)) return c.json({ error: 'Unauthorized' }, 401)

  const startTime = Date.now()

  try {
    const { token, displayName } = await getValidAccessToken()
    const result = await syncActivityMetrics(token, displayName)

    await supabase.from('garmin_sync_log').insert({
      sync_type: 'activity_backfill',
      status: 'success',
      duration_ms: Date.now() - startTime,
      details: result,
    })

    return c.json({ status: 'ok', ...result })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error'
    console.error(`[garmin-sync] Activity sync error:`, err)

    await supabase.from('garmin_sync_log').insert({
      sync_type: 'activity_backfill',
      status: 'error',
      error_message: errMsg,
      duration_ms: Date.now() - startTime,
    }).catch(() => {})

    return c.json({ status: 'error', message: errMsg }, 500)
  }
})

// Run sync — Garmin as primary run data source (replaces Strava webhook)
app.post('/garmin-sync/run-sync', async (c) => {
  if (!checkAuth(c)) return c.json({ error: 'Unauthorized' }, 401)

  const startTime = Date.now()

  try {
    const { token, displayName } = await getValidAccessToken()
    const result = await syncGarminRuns(token, displayName)

    await supabase.from('garmin_sync_log').insert({
      sync_type: 'run_sync',
      status: result.synced > 0 ? 'success' : 'no_data',
      duration_ms: Date.now() - startTime,
      details: result,
    })

    return c.json({ status: 'ok', ...result })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error'
    console.error(`[garmin-sync] Run sync error:`, err)

    await supabase.from('garmin_sync_log').insert({
      sync_type: 'run_sync',
      status: 'error',
      error_message: errMsg,
      duration_ms: Date.now() - startTime,
    }).catch(() => {})

    return c.json({ status: 'error', message: errMsg }, 500)
  }
})

Deno.serve(app.fetch)
