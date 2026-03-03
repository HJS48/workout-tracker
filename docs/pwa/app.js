// ─── Config ──────────────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://xwfshemzhunaxbzjgata.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3ZnNoZW16aHVuYXhiempnYXRhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkxNzcyMzUsImV4cCI6MjA4NDc1MzIzNX0.xOusu_lQaqpBMwU0thhNIvPcG8p5i2ieGkxQtwzOgyE';

// ─── API Client ──────────────────────────────────────────────────────────────
async function rpc(fn, params = {}) {
  if (!navigator.onLine) throw new Error('offline');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': ANON_KEY,
      'Authorization': `Bearer ${ANON_KEY}`
    },
    body: JSON.stringify(params)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `RPC ${fn} failed (${res.status})`);
  }
  return res.json();
}

// ─── REST helpers ────────────────────────────────────────────────────────────
async function fetchSets(workoutId, exerciseId) {
  const url = `${SUPABASE_URL}/rest/v1/workout_sets?workout_id=eq.${workoutId}&exercise_id=eq.${exerciseId}&order=set_order.asc`;
  const res = await fetch(url, {
    headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${ANON_KEY}` }
  });
  if (!res.ok) return [];
  return (await res.json()).map(s => ({
    id: s.id, weight_kg: s.weight_kg, reps: s.reps, rpe: s.rpe
  }));
}

// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  screen: 'pin',
  mesocycle: null,
  readiness: null,
  selectedDay: null,
  weekNumber: null,
  workoutPlan: null,
  workoutId: null,
  workoutStartedAt: null,
  exerciseCues: {},
  loggedSets: {},       // { exerciseId: [set, ...] }
  feedback: {},         // { exerciseId: { pump, joint } }
  activeExercise: null, // index
  error: null,
  loading: false,
  editingSet: null,
};

// ─── PIN Logic ───────────────────────────────────────────────────────────────
const PIN_HASH_KEY = 'wt_pin_hash';
let pinBuffer = '';
let pinMode = 'enter'; // 'set', 'confirm', 'enter'
let pinSetBuffer = '';

async function hashPin(pin) {
  const data = new TextEncoder().encode(pin + 'workout-tracker-salt');
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hasPinSet() {
  return !!localStorage.getItem(PIN_HASH_KEY);
}

async function checkPin(pin) {
  const stored = localStorage.getItem(PIN_HASH_KEY);
  return stored === await hashPin(pin);
}

async function setPin(pin) {
  localStorage.setItem(PIN_HASH_KEY, await hashPin(pin));
}

// ─── Rendering ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const app = () => document.getElementById('app');

function render() {
  const screens = {
    pin: renderPinScreen,
    home: renderHomeScreen,
    setup: renderSetupScreen,
    session: renderSessionScreen,
    end: renderEndScreen,
  };
  const renderer = screens[state.screen];
  if (renderer) app().innerHTML = renderer();
  bindEvents();
}

// ─── PIN Screen ──────────────────────────────────────────────────────────────
function renderPinScreen() {
  if (!hasPinSet()) pinMode = 'set';
  const title = pinMode === 'set' ? 'Set PIN' : pinMode === 'confirm' ? 'Confirm PIN' : 'Enter PIN';
  const dots = [0,1,2,3].map(i =>
    `<div class="pin-dot ${i < pinBuffer.length ? 'filled' : ''}"></div>`
  ).join('');

  return `
    <div class="pin-screen">
      <h1>${title}</h1>
      <div class="pin-dots">${dots}</div>
      <div class="pin-msg" id="pin-msg"></div>
      <div class="pin-pad">
        ${[1,2,3,4,5,6,7,8,9].map(n =>
          `<button class="pin-key" data-key="${n}">${n}</button>`
        ).join('')}
        <button class="pin-key empty"></button>
        <button class="pin-key" data-key="0">0</button>
        <button class="pin-key" data-key="del">&#9003;</button>
      </div>
    </div>`;
}

async function handlePinKey(key) {
  if (key === 'del') {
    pinBuffer = pinBuffer.slice(0, -1);
    render();
    return;
  }
  pinBuffer += key;
  render();

  if (pinBuffer.length < 4) return;

  const pin = pinBuffer;
  pinBuffer = '';

  if (pinMode === 'set') {
    pinSetBuffer = pin;
    pinMode = 'confirm';
    render();
  } else if (pinMode === 'confirm') {
    if (pin === pinSetBuffer) {
      await setPin(pin);
      pinMode = 'enter';
      state.screen = 'home';
      render();
      loadHomeData();
    } else {
      pinMode = 'set';
      pinSetBuffer = '';
      render();
      showPinMsg('PINs did not match. Try again.', true);
    }
  } else {
    if (await checkPin(pin)) {
      state.screen = 'home';
      render();
      loadHomeData();
    } else {
      render();
      showPinMsg('Wrong PIN', true);
    }
  }
}

function showPinMsg(msg, isError) {
  const el = $('pin-msg');
  if (el) {
    el.textContent = msg;
    el.className = isError ? 'pin-msg error' : 'pin-msg';
    if (isError) {
      document.querySelectorAll('.pin-dot').forEach(d => d.classList.add('error'));
      setTimeout(() => {
        document.querySelectorAll('.pin-dot').forEach(d => d.classList.remove('error'));
        if (el) el.textContent = '';
      }, 1000);
    }
  }
}

// ─── Home Screen ─────────────────────────────────────────────────────────────
function renderHomeScreen() {
  const today = new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
  const offline = !navigator.onLine ? '<div class="offline-banner">Offline — cached data only</div>' : '';
  const error = state.error ? `<div class="error-msg">${esc(state.error)}</div>` : '';

  let mesoInfo = '<div class="loading">Loading...</div>';
  if (state.mesocycle) {
    const m = state.mesocycle;
    const weekNum = calcWeekNumber(m.start_date);
    state.weekNumber = weekNum;
    mesoInfo = `
      <div class="card">
        <div class="card-title">Active Mesocycle</div>
        <div style="font-size:18px;font-weight:600">${esc(m.name)}</div>
        <div class="text-dim text-sm">${esc(m.focus || '')} &middot; Week ${weekNum}</div>
      </div>`;
  }

  let readinessInfo = '';
  if (state.readiness) {
    const r = state.readiness;
    readinessInfo = `
      <div class="card">
        <div class="card-title">Readiness</div>
        <div class="readiness-grid">
          <div class="readiness-item">
            <span class="readiness-label">Body Battery</span>
            <span class="readiness-value">${r.body_battery_morning ?? '—'}</span>
          </div>
          <div class="readiness-item">
            <span class="readiness-label">Sleep Score</span>
            <span class="readiness-value">${r.sleep_score ?? '—'}</span>
          </div>
          <div class="readiness-item">
            <span class="readiness-label">Stress Avg</span>
            <span class="readiness-value">${r.stress_avg ?? '—'}</span>
          </div>
          <div class="readiness-item">
            <span class="readiness-label">RHR</span>
            <span class="readiness-value">${r.resting_heart_rate ?? '—'}</span>
          </div>
        </div>
      </div>`;
  }

  let dayPicker = '';
  if (state.mesocycle?.days?.length) {
    dayPicker = `
      <div class="card">
        <div class="card-title">Start Workout</div>
        <div class="day-list">
          ${state.mesocycle.days.map(d => `
            <button class="day-btn" data-day-id="${d.id}">
              <div class="day-name">Day ${d.day_number}: ${esc(d.name)}</div>
              ${d.notes ? `<div class="day-notes">${esc(d.notes)}</div>` : ''}
            </button>
          `).join('')}
        </div>
      </div>`;
  }

  return `
    ${offline}
    ${error}
    <div class="header">
      <div>
        <h1>Workout Tracker</h1>
        <div class="header-date">${today}</div>
      </div>
    </div>
    ${mesoInfo}
    ${readinessInfo}
    ${dayPicker}`;
}

async function loadHomeData() {
  state.error = null;
  try {
    const [meso, readiness] = await Promise.all([
      rpc('get_active_mesocycle'),
      rpc('get_garmin_readiness_snapshot').catch(() => null)
    ]);
    state.mesocycle = meso;
    state.readiness = readiness;
  } catch (e) {
    state.error = e.message === 'offline' ? 'You are offline' : `Failed to load: ${e.message}`;
  }
  render();
}

function calcWeekNumber(startDate) {
  const start = new Date(startDate);
  const now = new Date();
  const diff = Math.floor((now - start) / (7 * 24 * 60 * 60 * 1000));
  return Math.max(1, diff + 1);
}

// ─── Setup Screen ────────────────────────────────────────────────────────────
function renderSetupScreen() {
  const day = state.selectedDay;
  const error = state.error ? `<div class="error-msg">${esc(state.error)}</div>` : '';

  const muscles = ['chest','back','shoulders','biceps','triceps','quads','hamstrings','glutes','calves','core'];

  return `
    <div class="header">
      <button class="back-btn" data-action="back-home">&larr; Back</button>
      <h1>Day ${day.day_number}: ${esc(day.name)}</h1>
      <div></div>
    </div>
    ${error}
    <div class="card">
      <div class="card-title">Week ${state.weekNumber}</div>
    </div>

    <div class="card">
      <div class="card-title">How are you feeling?</div>
      <div class="form-group">
        <label class="form-label">Sleep Quality</label>
        <div class="rating-row" data-field="sleep">
          ${[1,2,3,4,5].map(n => `<button class="rating-btn" data-val="${n}">${n}</button>`).join('')}
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Energy Level</label>
        <div class="rating-row" data-field="energy">
          ${[1,2,3,4,5].map(n => `<button class="rating-btn" data-val="${n}">${n}</button>`).join('')}
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Muscle Soreness (tap to set 1-5, tap again to clear)</label>
        <div class="soreness-grid" id="soreness-grid">
          ${muscles.map(m => `<button class="soreness-chip" data-muscle="${m}">${m}<span class="level"></span></button>`).join('')}
        </div>
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">Pre-session Notes (optional)</label>
      <textarea id="pre-notes" rows="2" placeholder="How do you feel? Any issues?"></textarea>
    </div>

    <button class="btn btn-primary mt-12" id="start-workout-btn" ${state.loading ? 'disabled' : ''}>
      ${state.loading ? 'Starting...' : 'Start Session'}
    </button>`;
}

const setupState = { sleep: null, energy: null, soreness: {} };

function handleSetupRating(field, val) {
  setupState[field] = val;
  document.querySelectorAll(`[data-field="${field}"] .rating-btn`).forEach(b => {
    b.classList.toggle('selected', parseInt(b.dataset.val) === val);
  });
}

function handleSoreness(muscle) {
  const current = setupState.soreness[muscle] || 0;
  const next = current >= 5 ? 0 : current + 1;
  if (next === 0) delete setupState.soreness[muscle];
  else setupState.soreness[muscle] = next;

  const chip = document.querySelector(`[data-muscle="${muscle}"]`);
  if (chip) {
    chip.classList.toggle('active', next > 0);
    chip.querySelector('.level').textContent = next > 0 ? ` ${next}` : '';
  }
}

async function startWorkout() {
  state.loading = true;
  state.error = null;
  render();

  try {
    const params = {
      p_mesocycle_id: state.mesocycle.id,
      p_mesocycle_day_id: state.selectedDay.id,
      p_week_number: state.weekNumber,
      p_date: new Date().toISOString().slice(0, 10),
    };
    if (setupState.sleep) params.p_sleep_quality = setupState.sleep;
    if (setupState.energy) params.p_energy_level = setupState.energy;
    if (Object.keys(setupState.soreness).length > 0) params.p_muscle_soreness = setupState.soreness;

    const notes = $('pre-notes')?.value?.trim();
    if (notes) params.p_pre_session_notes = notes;

    const result = await rpc('start_workout', params);
    state.workoutId = result.workout_id;
    state.workoutStartedAt = new Date();

    // Load workout plan
    const plan = await rpc('get_workout_plan', {
      p_mesocycle_id: state.mesocycle.id,
      p_day_id: state.selectedDay.id,
      p_week_number: state.weekNumber
    });
    state.workoutPlan = plan;
    state.activeExercise = 0;
    state.loggedSets = {};
    state.feedback = {};

    // Load cues for all exercises
    const exerciseIds = plan.map(e => e.exercise_id);
    if (exerciseIds.length > 0) {
      try {
        const cues = await rpc('get_exercise_cues', { p_exercise_ids: exerciseIds });
        if (Array.isArray(cues)) {
          cues.forEach(c => { state.exerciseCues[c.exercise_id] = c.notes; });
        }
      } catch (_) { /* cues are optional */ }
    }

    state.screen = 'session';
  } catch (e) {
    state.error = e.message === 'offline' ? 'Cannot start workout while offline' : e.message;
  }
  state.loading = false;
  render();
}

// ─── Session Screen ──────────────────────────────────────────────────────────
function renderSessionScreen() {
  const plan = state.workoutPlan || [];
  const error = state.error ? `<div class="error-msg">${esc(state.error)}</div>` : '';
  const offline = !navigator.onLine ? '<div class="offline-banner">Offline — sets won\'t save</div>' : '';

  let currentSuperset = null;
  let cards = '';
  plan.forEach((ex, i) => {
    const isActive = i === state.activeExercise;
    const sets = state.loggedSets[ex.exercise_id] || [];
    const fb = state.feedback[ex.exercise_id] || {};
    const targetStr = `${ex.target_sets}x${ex.target_reps || '?'}${ex.target_weight_kg ? ` @ ${ex.target_weight_kg}kg` : ''}`;
    const cues = state.exerciseCues[ex.exercise_id];

    // Superset group label
    if (ex.superset_group && ex.superset_group !== currentSuperset) {
      currentSuperset = ex.superset_group;
      cards += `<div class="superset-label">${esc(ex.superset_group)}</div>`;
    } else if (!ex.superset_group && currentSuperset) {
      currentSuperset = null;
    }

    cards += `
      <div class="exercise-card ${isActive ? 'active' : ''}" data-idx="${i}">
        <div class="exercise-header" data-toggle="${i}">
          <div>
            <div class="exercise-name">${esc(ex.exercise_name)}</div>
            <div class="exercise-target">${esc(targetStr)}</div>
          </div>
          <div class="exercise-status">${sets.length > 0 ? `${sets.length} set${sets.length > 1 ? 's' : ''}` : ''}</div>
        </div>
        ${isActive ? `
          <div class="exercise-body">
            ${cues ? `<div class="exercise-cues">${esc(cues)}</div>` : ''}
            <div class="set-input-row">
              <div class="input-group">
                <label>Weight (kg)</label>
                <input type="number" id="input-weight" inputmode="decimal" step="0.5"
                  value="${getLastWeight(ex.exercise_id, ex.target_weight_kg)}" />
              </div>
              <div class="input-group">
                <label>Reps</label>
                <input type="number" id="input-reps" inputmode="numeric"
                  value="${getLastReps(ex.exercise_id)}" />
              </div>
              <div class="input-group">
                <label>RPE</label>
                <input type="number" id="input-rpe" inputmode="decimal" step="0.5" min="1" max="10"
                  placeholder="—" />
              </div>
            </div>
            <button class="btn btn-primary" data-action="log-set" data-eid="${ex.exercise_id}"
              ${state.loading ? 'disabled' : ''}>Log Set</button>

            ${sets.length > 0 ? `
              <div class="logged-sets">
                ${sets.map((s, si) => `
                  <div class="logged-set">
                    <span class="set-num">${si + 1}</span>
                    <span class="set-detail">${s.weight_kg ?? 0}kg x ${s.reps}${s.rpe ? ` @ RPE ${s.rpe}` : ''}</span>
                    <div class="set-actions">
                      <button class="set-action-btn" data-action="edit-set" data-set-idx="${si}" data-eid="${ex.exercise_id}">Edit</button>
                      <button class="set-action-btn delete" data-action="delete-set" data-set-id="${s.id}" data-eid="${ex.exercise_id}">Del</button>
                    </div>
                  </div>
                `).join('')}
              </div>` : ''}

            <div class="feedback-row">
              <div class="feedback-group">
                <div class="feedback-label">Pump</div>
                <div class="feedback-btns" data-fb="pump" data-eid="${ex.exercise_id}">
                  ${[1,2,3,4,5].map(n => `<button class="feedback-btn ${fb.pump === n ? 'selected' : ''}" data-val="${n}">${n}</button>`).join('')}
                </div>
              </div>
              <div class="feedback-group">
                <div class="feedback-label">Joint</div>
                <div class="feedback-btns" data-fb="joint" data-eid="${ex.exercise_id}">
                  ${[0,1,2,3,4,5].map(n => `<button class="feedback-btn ${fb.joint === n ? 'selected' : ''}" data-val="${n}">${n}</button>`).join('')}
                </div>
              </div>
            </div>
          </div>` : ''}
      </div>`;
  });

  return `
    ${offline}
    ${error}
    <div class="header">
      <button class="back-btn" data-action="end-workout">End Workout</button>
      <h1>${esc(state.selectedDay?.name || 'Workout')}</h1>
      <div class="text-dim text-sm">${elapsedTime()}</div>
    </div>
    ${cards}
    ${state.editingSet ? renderEditModal() : ''}`;
}

function getLastWeight(exerciseId, targetWeight) {
  const sets = state.loggedSets[exerciseId] || [];
  if (sets.length > 0) return sets[sets.length - 1].weight_kg ?? '';
  return targetWeight ?? '';
}

function getLastReps(exerciseId) {
  const sets = state.loggedSets[exerciseId] || [];
  if (sets.length > 0) return sets[sets.length - 1].reps ?? '';
  return '';
}

function elapsedTime() {
  if (!state.workoutStartedAt) return '';
  const diff = Math.floor((Date.now() - state.workoutStartedAt) / 60000);
  return `${diff} min`;
}

async function logSet(exerciseId) {
  const weight = parseFloat($('input-weight')?.value);
  const reps = parseInt($('input-reps')?.value);
  const rpe = parseFloat($('input-rpe')?.value) || null;

  if (!reps || reps <= 0) { state.error = 'Enter reps'; render(); return; }

  state.loading = true;
  state.error = null;
  render();

  try {
    const setData = { reps };
    if (!isNaN(weight)) setData.weight_kg = weight;
    if (rpe) setData.rpe = rpe;

    await rpc('log_sets', {
      p_workout_id: state.workoutId,
      p_exercise_id: exerciseId,
      p_sets: [setData]
    });

    // Fetch all sets for this exercise to get real IDs
    const sets = await fetchSets(state.workoutId, exerciseId);
    state.loggedSets[exerciseId] = sets;
  } catch (e) {
    state.error = e.message;
  }
  state.loading = false;
  render();
}

async function deleteSet(setId, exerciseId) {
  try {
    await rpc('delete_set', { p_set_id: setId });
    state.loggedSets[exerciseId] = (state.loggedSets[exerciseId] || []).filter(s => s.id !== setId);
  } catch (e) {
    state.error = e.message;
  }
  render();
}

function renderEditModal() {
  const s = state.editingSet;
  return `
    <div class="modal-overlay" data-action="close-modal">
      <div class="modal" onclick="event.stopPropagation()">
        <h3>Edit Set ${s.idx + 1}</h3>
        <div class="set-input-row">
          <div class="input-group">
            <label>Weight</label>
            <input type="number" id="edit-weight" inputmode="decimal" step="0.5" value="${s.set.weight_kg ?? ''}">
          </div>
          <div class="input-group">
            <label>Reps</label>
            <input type="number" id="edit-reps" inputmode="numeric" value="${s.set.reps ?? ''}">
          </div>
          <div class="input-group">
            <label>RPE</label>
            <input type="number" id="edit-rpe" inputmode="decimal" step="0.5" min="1" max="10" value="${s.set.rpe ?? ''}">
          </div>
        </div>
        <div style="display:flex;gap:8px" class="mt-16">
          <button class="btn btn-secondary" data-action="close-modal" style="flex:1">Cancel</button>
          <button class="btn btn-primary" data-action="save-edit" style="flex:1">Save</button>
        </div>
      </div>
    </div>`;
}

async function saveEditedSet() {
  const s = state.editingSet;
  const weight = parseFloat($('edit-weight')?.value);
  const reps = parseInt($('edit-reps')?.value);
  const rpe = parseFloat($('edit-rpe')?.value) || null;

  try {
    const params = { p_set_id: s.set.id };
    if (!isNaN(weight)) params.p_weight_kg = weight;
    if (reps) params.p_reps = reps;
    if (rpe) params.p_rpe = rpe;
    await rpc('update_set', params);
  } catch (e) {
    state.error = e.message;
    state.editingSet = null;
    render();
    return;
  }

  // Update local state
  const sets = state.loggedSets[s.exerciseId];
  if (sets && sets[s.idx]) {
    if (!isNaN(weight)) sets[s.idx].weight_kg = weight;
    if (reps) sets[s.idx].reps = reps;
    sets[s.idx].rpe = rpe;
  }
  state.editingSet = null;
  render();
}

async function handleFeedback(exerciseId, type, val) {
  if (!state.feedback[exerciseId]) state.feedback[exerciseId] = {};
  state.feedback[exerciseId][type] = val;

  try {
    const params = {
      p_workout_id: state.workoutId,
      p_exercise_id: exerciseId,
    };
    if (type === 'pump') params.p_pump_quality = val;
    if (type === 'joint') params.p_joint_discomfort = val;
    await rpc('log_exercise_feedback', params);
  } catch (_) { /* best effort */ }

  render();
}

// ─── End Screen ──────────────────────────────────────────────────────────────
function renderEndScreen() {
  const totalSets = Object.values(state.loggedSets).reduce((a, s) => a + s.length, 0);
  const duration = state.workoutStartedAt
    ? Math.floor((Date.now() - state.workoutStartedAt) / 60000)
    : 0;
  const error = state.error ? `<div class="error-msg">${esc(state.error)}</div>` : '';

  return `
    <div class="header">
      <button class="back-btn" data-action="back-session">&larr; Back</button>
      <h1>End Workout</h1>
      <div></div>
    </div>
    ${error}
    <div class="card">
      <div class="card-title">Summary</div>
      <div class="summary-stat">
        <span class="stat-label">Duration</span>
        <span class="stat-value">${duration} min</span>
      </div>
      <div class="summary-stat">
        <span class="stat-label">Total Sets</span>
        <span class="stat-value">${totalSets}</span>
      </div>
      <div class="summary-stat">
        <span class="stat-label">Exercises</span>
        <span class="stat-value">${Object.keys(state.loggedSets).length}</span>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Session Rating</div>
      <div class="rating-row" data-field="end-rating">
        ${[1,2,3,4,5].map(n => `<button class="rating-btn" data-val="${n}">${n}</button>`).join('')}
      </div>
    </div>

    <div class="form-group mt-12">
      <label class="form-label">Notes (optional)</label>
      <textarea id="end-notes" rows="3" placeholder="How did the session go?"></textarea>
    </div>

    <button class="btn btn-primary mt-16" id="finish-btn" ${state.loading ? 'disabled' : ''}>
      ${state.loading ? 'Saving...' : 'Finish Workout'}
    </button>`;
}

let endRating = null;

async function finishWorkout() {
  state.loading = true;
  state.error = null;
  render();

  try {
    const params = { p_workout_id: state.workoutId };
    if (endRating) params.p_rating = endRating;
    const notes = $('end-notes')?.value?.trim();
    if (notes) params.p_notes = notes;

    await rpc('end_workout', params);

    // Reset state and go home
    state.workoutId = null;
    state.workoutStartedAt = null;
    state.workoutPlan = null;
    state.loggedSets = {};
    state.feedback = {};
    state.activeExercise = null;
    state.selectedDay = null;
    state.editingSet = null;
    endRating = null;
    setupState.sleep = null;
    setupState.energy = null;
    setupState.soreness = {};

    state.screen = 'home';
    state.loading = false;
    render();
    loadHomeData();
  } catch (e) {
    state.error = e.message;
    state.loading = false;
    render();
  }
}

// ─── Event Binding ───────────────────────────────────────────────────────────
function bindEvents() {
  // PIN keys
  document.querySelectorAll('.pin-key[data-key]').forEach(btn => {
    btn.onclick = () => handlePinKey(btn.dataset.key);
  });

  // Day picker
  document.querySelectorAll('.day-btn').forEach(btn => {
    btn.onclick = () => {
      const dayId = btn.dataset.dayId;
      state.selectedDay = state.mesocycle.days.find(d => d.id === dayId);
      state.screen = 'setup';
      state.error = null;
      setupState.sleep = null;
      setupState.energy = null;
      setupState.soreness = {};
      render();
    };
  });

  // Setup ratings
  document.querySelectorAll('.rating-row[data-field]').forEach(row => {
    const field = row.dataset.field;
    row.querySelectorAll('.rating-btn').forEach(btn => {
      btn.onclick = () => {
        const val = parseInt(btn.dataset.val);
        if (field === 'end-rating') {
          endRating = val;
          row.querySelectorAll('.rating-btn').forEach(b => b.classList.toggle('selected', parseInt(b.dataset.val) === val));
        } else {
          handleSetupRating(field, val);
        }
      };
    });
  });

  // Soreness
  document.querySelectorAll('.soreness-chip').forEach(chip => {
    chip.onclick = () => handleSoreness(chip.dataset.muscle);
  });

  // Start workout
  const startBtn = $('start-workout-btn');
  if (startBtn) startBtn.onclick = startWorkout;

  // Exercise toggle
  document.querySelectorAll('[data-toggle]').forEach(el => {
    el.onclick = () => {
      const idx = parseInt(el.dataset.toggle);
      state.activeExercise = state.activeExercise === idx ? null : idx;
      state.error = null;
      render();
    };
  });

  // Log set
  document.querySelectorAll('[data-action="log-set"]').forEach(btn => {
    btn.onclick = () => logSet(btn.dataset.eid);
  });

  // Delete set
  document.querySelectorAll('[data-action="delete-set"]').forEach(btn => {
    btn.onclick = () => deleteSet(btn.dataset.setId, btn.dataset.eid);
  });

  // Edit set
  document.querySelectorAll('[data-action="edit-set"]').forEach(btn => {
    btn.onclick = () => {
      const eid = btn.dataset.eid;
      const idx = parseInt(btn.dataset.setIdx);
      const sets = state.loggedSets[eid] || [];
      state.editingSet = { exerciseId: eid, idx, set: { ...sets[idx] } };
      render();
    };
  });

  // Save edit
  document.querySelectorAll('[data-action="save-edit"]').forEach(btn => {
    btn.onclick = saveEditedSet;
  });

  // Close modal
  document.querySelectorAll('[data-action="close-modal"]').forEach(el => {
    el.onclick = (e) => {
      if (e.target === el) { state.editingSet = null; render(); }
    };
  });

  // Feedback buttons
  document.querySelectorAll('.feedback-btns[data-fb]').forEach(group => {
    const type = group.dataset.fb;
    const eid = group.dataset.eid;
    group.querySelectorAll('.feedback-btn').forEach(btn => {
      btn.onclick = () => handleFeedback(eid, type, parseInt(btn.dataset.val));
    });
  });

  // Navigation
  document.querySelectorAll('[data-action="back-home"]').forEach(btn => {
    btn.onclick = () => { state.screen = 'home'; state.error = null; render(); };
  });
  document.querySelectorAll('[data-action="end-workout"]').forEach(btn => {
    btn.onclick = () => { state.screen = 'end'; state.error = null; render(); };
  });
  document.querySelectorAll('[data-action="back-session"]').forEach(btn => {
    btn.onclick = () => { state.screen = 'session'; state.error = null; render(); };
  });

  // Finish workout
  const finishBtn = $('finish-btn');
  if (finishBtn) finishBtn.onclick = finishWorkout;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Timer update ────────────────────────────────────────────────────────────
setInterval(() => {
  if (state.screen === 'session') {
    const el = document.querySelector('.header .text-dim');
    if (el) el.textContent = elapsedTime();
  }
}, 30000);

// ─── Online/offline events ───────────────────────────────────────────────────
window.addEventListener('online', render);
window.addEventListener('offline', render);

// ─── Service Worker Registration ─────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ─── Init ────────────────────────────────────────────────────────────────────
render();
