// =============================================================================
// STRAVA WEBHOOK — DISABLED 2026-03-01
// Garmin is now the primary run data source (richer data, no intermediary).
// This webhook is kept deployed but inactive (subscription deleted).
// TO RE-ENABLE: Create a new Strava webhook subscription:
//   curl -X POST https://www.strava.com/api/v3/push_subscriptions \
//     -d client_id=YOUR_ID -d client_secret=YOUR_SECRET \
//     -d callback_url=https://xwfshemzhunaxbzjgata.supabase.co/functions/v1/strava-webhook \
//     -d verify_token=YOUR_VERIFY_TOKEN
// Then update pg_cron or disable garmin run-sync as needed.
// =============================================================================

import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://xwfshemzhunaxbzjgata.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const STRAVA_CLIENT_ID = Deno.env.get('STRAVA_CLIENT_ID')!
const STRAVA_CLIENT_SECRET = Deno.env.get('STRAVA_CLIENT_SECRET')!
const STRAVA_VERIFY_TOKEN = Deno.env.get('STRAVA_VERIFY_TOKEN')!

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// =============================================================================
// STRAVA API HELPERS
// =============================================================================

/** Refresh access token if expired, return valid access_token */
async function getValidAccessToken(): Promise<string> {
  const { data: tokens } = await supabase.rpc('get_strava_tokens')
  if (!tokens) throw new Error('No Strava tokens found. Complete OAuth first.')

  const now = Math.floor(Date.now() / 1000)

  // If token expires in more than 5 minutes, use it
  if (tokens.expires_at > now + 300) {
    return tokens.access_token
  }

  // Refresh the token
  console.log('[strava] Refreshing access token...')
  const resp = await fetch('https://www.strava.com/api/v3/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: parseInt(STRAVA_CLIENT_ID),
      client_secret: STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    }),
  })

  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`Token refresh failed: ${resp.status} ${errText}`)
  }

  const refreshed = await resp.json()

  // Save new tokens
  await supabase.rpc('save_strava_tokens', {
    p_athlete_id: tokens.athlete_id,
    p_access_token: refreshed.access_token,
    p_refresh_token: refreshed.refresh_token,
    p_expires_at: refreshed.expires_at,
  })

  return refreshed.access_token
}

/** Fetch full activity from Strava API */
async function fetchStravaActivity(activityId: number, accessToken: string) {
  const resp = await fetch(
    `https://www.strava.com/api/v3/activities/${activityId}?include_all_efforts=false`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`Strava API error ${resp.status}: ${errText}`)
  }
  return await resp.json()
}

/** Fetch laps for an activity */
async function fetchStravaLaps(activityId: number, accessToken: string) {
  const resp = await fetch(
    `https://www.strava.com/api/v3/activities/${activityId}/laps`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  if (!resp.ok) return []
  return await resp.json()
}

/** Fetch heart rate zones for an activity */
async function fetchStravaZones(activityId: number, accessToken: string) {
  const resp = await fetch(
    `https://www.strava.com/api/v3/activities/${activityId}/zones`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  if (!resp.ok) return []
  return await resp.json()
}

// =============================================================================
// STRAVA -> DATABASE FIELD MAPPING
// =============================================================================

function mapRunType(activity: any): string | null {
  const workoutType = activity.workout_type
  if (workoutType === 1) return 'race'
  if (workoutType === 2) return 'long'
  if (workoutType === 3) return 'tempo'
  return 'easy'
}

function isRunActivity(activity: any): boolean {
  const runTypes = ['Run', 'TrailRun', 'VirtualRun']
  return runTypes.includes(activity.sport_type) || runTypes.includes(activity.type)
}

function mapActivityToRunSession(activity: any) {
  const startDate = new Date(activity.start_date_local || activity.start_date)

  return {
    p_external_id: String(activity.id),
    p_source: 'strava',
    p_date: startDate.toISOString().split('T')[0],
    p_started_at: activity.start_date,
    p_ended_at: activity.start_date
      ? new Date(new Date(activity.start_date).getTime() + (activity.elapsed_time * 1000)).toISOString()
      : null,
    p_run_type: mapRunType(activity),
    p_distance_m: activity.distance,
    p_duration_s: activity.moving_time,
    p_avg_pace_s_per_km: activity.distance > 0
      ? Math.round((activity.moving_time / (activity.distance / 1000)))
      : null,
    p_avg_heart_rate: activity.average_heartrate ? Math.round(activity.average_heartrate) : null,
    p_max_heart_rate: activity.max_heartrate ? Math.round(activity.max_heartrate) : null,
    p_avg_cadence: activity.average_cadence ? Math.round(activity.average_cadence * 2) : null,
    p_elevation_gain_m: activity.total_elevation_gain,
    p_elevation_loss_m: null,
    p_calories: activity.calories ? Math.round(activity.calories) : null,
    p_perceived_effort: activity.perceived_exertion
      ? Math.round(activity.perceived_exertion)
      : null,
    p_notes: activity.description || null,
  }
}

function mapLaps(stravaLaps: any[]): any[] {
  return stravaLaps.map((lap, idx) => ({
    lap_number: idx + 1,
    distance_m: lap.distance,
    duration_s: lap.moving_time,
    avg_pace_s_per_km: lap.distance > 0
      ? Math.round(lap.moving_time / (lap.distance / 1000))
      : null,
    avg_heart_rate: lap.average_heartrate ? Math.round(lap.average_heartrate) : null,
    max_heart_rate: lap.max_heartrate ? Math.round(lap.max_heartrate) : null,
    avg_cadence: lap.average_cadence ? Math.round(lap.average_cadence * 2) : null,
    elevation_gain_m: lap.total_elevation_gain,
  }))
}

function mapHrZones(stravaZones: any[]): any[] {
  const hrZone = stravaZones.find((z: any) => z.type === 'heartrate')
  if (!hrZone || !hrZone.distribution_buckets) return []

  return hrZone.distribution_buckets.map((bucket: any, idx: number) => ({
    zone_number: idx + 1,
    duration_s: bucket.time,
    min_hr: bucket.min,
    max_hr: bucket.max,
  }))
}

// =============================================================================
// WEBHOOK HANDLERS
// =============================================================================

async function handleActivityCreate(activityId: number) {
  const accessToken = await getValidAccessToken()
  const activity = await fetchStravaActivity(activityId, accessToken)

  if (!isRunActivity(activity)) {
    console.log(`[strava] Activity ${activityId} is ${activity.sport_type}, skipping (not a run)`)
    await supabase.from('strava_sync_log').insert({
      strava_activity_id: activityId,
      event_type: 'create',
      status: 'skipped',
      raw_payload: { sport_type: activity.sport_type },
    })
    return { status: 'skipped', reason: `Not a run: ${activity.sport_type}` }
  }

  const [stravaLaps, stravaZones] = await Promise.all([
    fetchStravaLaps(activityId, accessToken),
    fetchStravaZones(activityId, accessToken),
  ])

  const sessionParams = mapActivityToRunSession(activity)
  const laps = mapLaps(stravaLaps)
  const hrZones = mapHrZones(stravaZones)

  const { data, error } = await supabase.rpc('upsert_run_session', {
    ...sessionParams,
    p_laps: laps.length > 0 ? laps : null,
    p_hr_zones: hrZones.length > 0 ? hrZones : null,
  })

  if (error) throw new Error(`upsert_run_session failed: ${error.message}`)

  await supabase.from('strava_sync_log').insert({
    strava_activity_id: activityId,
    event_type: 'create',
    status: 'success',
    run_session_id: data.run_session_id,
    raw_payload: { sport_type: activity.sport_type, distance: activity.distance },
  })

  return data
}

async function handleActivityUpdate(activityId: number) {
  return await handleActivityCreate(activityId)
}

async function handleActivityDelete(activityId: number) {
  const { data, error } = await supabase.rpc('delete_run_session_by_external_id', {
    p_external_id: String(activityId),
    p_source: 'strava',
  })

  if (error) throw new Error(`delete_run_session failed: ${error.message}`)

  await supabase.from('strava_sync_log').insert({
    strava_activity_id: activityId,
    event_type: 'delete',
    status: data.deleted ? 'success' : 'skipped',
  })

  return data
}

// =============================================================================
// HTTP SERVER
// =============================================================================

const app = new Hono()

// Webhook validation (GET) -- Strava sends this when creating a subscription
app.get('/strava-webhook', (c) => {
  const mode = c.req.query('hub.mode')
  const token = c.req.query('hub.verify_token')
  const challenge = c.req.query('hub.challenge')

  console.log(`[strava-webhook] Validation: mode=${mode}, token=${token}`)

  if (mode === 'subscribe' && token === STRAVA_VERIFY_TOKEN) {
    console.log('[strava-webhook] Validation successful')
    return c.json({ 'hub.challenge': challenge })
  }

  return c.json({ error: 'Invalid verify token' }, 403)
})

// Webhook event (POST) -- Strava pushes events here
app.post('/strava-webhook', async (c) => {
  const event = await c.req.json()
  console.log(`[strava-webhook] Event: ${JSON.stringify(event)}`)

  if (event.object_type !== 'activity') {
    console.log(`[strava-webhook] Ignoring non-activity event: ${event.object_type}`)
    return c.json({ status: 'ignored' })
  }

  const activityId = event.object_id as number

  try {
    let result

    switch (event.aspect_type) {
      case 'create':
        result = await handleActivityCreate(activityId)
        break
      case 'update':
        result = await handleActivityUpdate(activityId)
        break
      case 'delete':
        result = await handleActivityDelete(activityId)
        break
      default:
        console.log(`[strava-webhook] Unknown aspect_type: ${event.aspect_type}`)
        return c.json({ status: 'unknown_event' })
    }

    console.log(`[strava-webhook] Processed: ${JSON.stringify(result)}`)
    return c.json({ status: 'ok' })
  } catch (err) {
    console.error(`[strava-webhook] Error processing activity ${activityId}:`, err)

    await supabase.from('strava_sync_log').insert({
      strava_activity_id: activityId,
      event_type: event.aspect_type,
      status: 'error',
      error_message: err instanceof Error ? err.message : 'Unknown error',
      raw_payload: event,
    }).catch(() => {})

    return c.json({ status: 'error' })
  }
})

Deno.serve(app.fetch)
