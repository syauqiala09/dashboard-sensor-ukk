'use strict';

// ══════════════════════════════════════════
//   AUTH CHECK
// ══════════════════════════════════════════
let authenticated = false;
try {
  authenticated = sessionStorage.getItem('isLoggedIn') === 'true';
} catch (e) {
  console.warn('sessionStorage diblokir oleh browser');
}

const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('auth') === 'true') {
  authenticated = true;
  try { sessionStorage.setItem('isLoggedIn', 'true'); } catch(e){}
}

if (!authenticated) {
  window.location.href = 'login.html';
}

// ══════════════════════════════════════════
//   SENSOR CONFIG
// ══════════════════════════════════════════
const CFG = {
  temp: {
    min: 0,   max: 50,
    warnLo: 15, warnHi: 28,
    dangerLo: 5, dangerHi: 31,
    color: '#ff6b2b',
    label: 'Suhu (°C)',
  },
  hum: {
    min: 0,   max: 100,
    warnLo: 30, warnHi: 75,
    dangerLo: 20, dangerHi: 90,
    color: '#3d7eff',
    label: 'Kelembaban (%)',
  },
  // LDR dari Arduino bersifat DIGITAL: 1 = TERANG, 0 = GELAP
  ldr: {
    min: 0,   max: 1,
    warnLo: -1, warnHi: 2,    // tidak ada zona warning untuk LDR digital
    dangerLo: 0.5, dangerHi: 2, // nilai 0 (GELAP) → BAHAYA
    color: '#f5b800',
    label: 'Cahaya (LDR)',
  },
};

// ══════════════════════════════════════════
//   STATE
// ══════════════════════════════════════════
const HISTORY_LEN = 20;

const state = {
  temp: { history: [], min: Infinity, max: -Infinity, current: null },
  hum:  { history: [], min: Infinity, max: -Infinity, current: null },
  ldr:  { history: [], min: Infinity, max: -Infinity, current: null },
  log:  [],
  activeChart : 'temp',
  mode        : 'MANUAL',   // 'AUTO' | 'MANUAL'
  mqttConnected: false,
  tempWarningShown: false,
  wasDanger: false,
};

// ══════════════════════════════════════════
//   HELPERS
// ══════════════════════════════════════════
const $ = id => document.getElementById(id);

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function getStatus(key, val) {
  if (val === null || val === undefined) return '—';
  const c = CFG[key];
  if (val <= c.dangerLo || val >= c.dangerHi) return 'BAHAYA';
  if (val <= c.warnLo   || val >= c.warnHi)   return 'PERINGATAN';
  return 'NORMAL';
}

function statusClass(s) {
  if (s === 'NORMAL')     return 's-normal';
  if (s === 'PERINGATAN') return 's-warning';
  if (s === 'BAHAYA')     return 's-danger';
  return '';
}

function statusTdClass(s) {
  if (s === 'NORMAL')     return 'status-ok';
  if (s === 'PERINGATAN') return 'status-warn';;
  if (s === 'BAHAYA')     return 'status-err';
  return '';
}

function fmtTime(d) {
  return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function showToast(msg, dur = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), dur);
}

// ══════════════════════════════════════════
//   MQTT CONNECTION STATUS UI
// ══════════════════════════════════════════
function updateConnectionStatus(connected) {
  state.mqttConnected = connected;
  const badge = $('mqtt-badge');
  const label = $('mqtt-label');
  if (connected) {
    badge.className = 'mqtt-badge connected';
    label.textContent = 'HiveMQ Online';
  } else {
    badge.className = 'mqtt-badge disconnected';
    label.textContent = 'Menghubungkan…';
  }
}

// ══════════════════════════════════════════
//   MODE (AUTO / MANUAL)
// ══════════════════════════════════════════
function applyMode(mode) {
  state.mode = mode;
  const isAuto = mode === 'AUTO';
  const btn    = $('btn-mode');
  btn.textContent  = isAuto ? '🤖 AUTO' : '⚙ MANUAL';
  btn.dataset.auto = String(isAuto);
  btn.classList.toggle('active', isAuto);

  // Di AUTO mode, tombol relay individual di-disable
  document.querySelectorAll('.led-toggle').forEach(b => {
    b.disabled = isAuto;
    b.style.opacity = isAuto ? '0.45' : '1';
  });
  $('btn-all-on').disabled  = isAuto;
  $('btn-all-off').disabled = isAuto;
}

// ══════════════════════════════════════════
//   PROCESS INCOMING MQTT DATA
//   Payload: { temp, humi, ldr, mode, r:[0,1,0,0] }
// ══════════════════════════════════════════
function processIncomingData(data) {
  const now = new Date();

  // ── Sensor values ────────────────────────────────────────
  const tempVal = (data.temp !== undefined) ? parseFloat(data.temp) : null;
  const humVal  = (data.humi !== undefined) ? parseFloat(data.humi) : null;
  const ldrVal  = (data.ldr  !== undefined) ? parseInt(data.ldr, 10) : null;

  if (tempVal !== null && !isNaN(tempVal)) pushSensor('temp', tempVal);
  if (humVal  !== null && !isNaN(humVal))  pushSensor('hum',  humVal);
  if (ldrVal  !== null && !isNaN(ldrVal))  pushSensor('ldr',  ldrVal);

  // ── Log entry ─────────────────────────────────────────────
  if (tempVal !== null) {
    const worstStatus = ['temp','hum','ldr']
      .map(k => getStatus(k, state[k].current))
      .filter(s => s !== '—')
      .sort((a,b) => ({ BAHAYA:2, PERINGATAN:1, NORMAL:0 }[b] - { BAHAYA:2, PERINGATAN:1, NORMAL:0 }[a]))[0]
      || 'NORMAL';

    const entry = {
      time  : now,
      temp  : state.temp.current,
      hum   : state.hum.current,
      ldr   : state.ldr.current,
      status: worstStatus,
    };
    state.log.unshift(entry);
    // Batasan 10 log telah dihapus agar semua data tersimpan dan bisa diekspor
  }

  // ── Relay/LED states dari r[] ─────────────────────────────
  if (Array.isArray(data.r)) {
    data.r.forEach((val, i) => setLed(i + 1, val === 1, 'mqtt'));
  }

  // ── Mode ──────────────────────────────────────────────────
  if (data.mode) applyMode(data.mode);

  // ── Render UI ─────────────────────────────────────────────
  updateCards();
  drawChart();
  updateLog();
  updateFooter();

  // ── Alert toast untuk BAHAYA ──────────────────────────────
  ['temp','hum','ldr'].forEach(key => {
    if (getStatus(key, state[key].current) === 'BAHAYA') {
      const names = { temp:'Suhu', hum:'Kelembaban', ldr:'Cahaya' };
      showToast(`⚠️ ${names[key]} dalam kondisi BAHAYA!`, 3000);
    }
  });
}

function pushSensor(key, val) {
  const s = state[key];
  s.current = val;
  s.history.push(val);
  if (s.history.length > HISTORY_LEN) s.history.shift();
  if (val < s.min) s.min = val;
  if (val > s.max) s.max = val;
}

// ══════════════════════════════════════════
//   UPDATE SENSOR CARDS
// ══════════════════════════════════════════
function updateCards() {
  ['temp', 'hum', 'ldr'].forEach(key => {
    const s      = state[key];
    const val    = s.current;
    const cfg    = CFG[key];

    if (val === null) return;

    const status = getStatus(key, val);

    // ── Tampilan nilai ─────────────────────────────────────
    const valEl = $('val-' + key);
    if (key === 'ldr') {
      // LDR adalah digital: 1 = TERANG, 0 = GELAP
      valEl.textContent = val === 1 ? 'TERANG' : 'GELAP';
    } else {
      valEl.textContent = val;
    }

    // ── Warna berdasar status ──────────────────────────────
    if (status === 'BAHAYA')     valEl.style.color = '#ff2b2b';
    else if (status === 'PERINGATAN') valEl.style.color = '#c97a00';
    else                         valEl.style.color = '';

    // ── Status badge ───────────────────────────────────────
    const stEl = $('status-' + key);
    stEl.textContent = status;
    stEl.className   = 'sensor-status ' + statusClass(status);

    // ── Min / Max ──────────────────────────────────────────
    const fmtLdr = v => (v === null || v === Infinity || v === -Infinity) ? '--' : (v === 1 ? 'TERANG' : 'GELAP');
    if (key === 'ldr') {
      $('min-' + key).textContent = fmtLdr(s.min === Infinity  ? null : s.min);
      $('max-' + key).textContent = fmtLdr(s.max === -Infinity ? null : s.max);
    } else {
      $('min-' + key).textContent = s.min === Infinity  ? '--' : s.min;
      $('max-' + key).textContent = s.max === -Infinity ? '--' : s.max;
    }

    // ── Gauge ──────────────────────────────────────────────
    const pct = ((val - cfg.min) / (cfg.max - cfg.min)) * 100;
    $('gauge-' + key).style.width = clamp(pct, 0, 100) + '%';

    // ── Peringatan Suhu >= 31 ──────────────────────────────
    if (key === 'temp') {
      const cardTemp = $('card-temp');
      const modal = $('warning-modal');
      if (val >= 31) {
        cardTemp.classList.add('blink-red');
        if (!state.tempWarningShown) {
          if (modal) modal.classList.add('show');
          state.tempWarningShown = true;
        }
      } else {
        cardTemp.classList.remove('blink-red');
        state.tempWarningShown = false;
        if (modal) modal.classList.remove('show');
      }
    }
  });
}

// ══════════════════════════════════════════
//   LINE CHART
// ══════════════════════════════════════════
const lineCtx = { canvas: null, ctx: null };

function initChart() {
  const canvas = $('line-chart');
  lineCtx.canvas = canvas;
  lineCtx.ctx    = canvas.getContext('2d');
  resizeChart();
  window.addEventListener('resize', resizeChart);
}

function resizeChart() {
  const wrap = lineCtx.canvas.parentElement;
  lineCtx.canvas.width  = wrap.clientWidth;
  lineCtx.canvas.height = wrap.clientHeight;
  drawChart();
}

function drawChart() {
  const canvas = lineCtx.canvas;
  const ctx    = lineCtx.ctx;
  const key    = state.activeChart;
  const data   = state[key].history;
  const cfg    = CFG[key];

  const W = canvas.width;
  const H = canvas.height;
  const PAD = { top: 18, right: 12, bottom: 28, left: 46 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top  - PAD.bottom;

  ctx.clearRect(0, 0, W, H);

  if (data.length < 2) {
    ctx.fillStyle   = '#aaa';
    ctx.font        = "bold 13px 'Space Grotesk', sans-serif";
    ctx.textAlign   = 'center';
    ctx.fillText('Menunggu data dari ESP32…', W / 2, H / 2);
    return;
  }

  const dataMin = Math.min(...data);
  const dataMax = Math.max(...data);
  const range   = dataMax - dataMin || 1;
  const padded  = range * 0.15;
  const yLo     = dataMin - padded;
  const yHi     = dataMax + padded;

  function toX(i) { return PAD.left + (i / (HISTORY_LEN - 1)) * innerW; }
  function toY(v) { return PAD.top + innerH - ((v - yLo) / (yHi - yLo)) * innerH; }

  // ── Grid lines ─────────────────────────────────────────────
  ctx.strokeStyle = 'rgba(0,0,0,0.08)';
  ctx.lineWidth   = 1;
  const gridCount = 4;
  for (let i = 0; i <= gridCount; i++) {
    const y = PAD.top + (innerH / gridCount) * i;
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(PAD.left + innerW, y);
    ctx.stroke();

    const val = yHi - ((yHi - yLo) / gridCount) * i;
    ctx.fillStyle  = '#888';
    ctx.font       = "bold 10px 'Space Mono', monospace";
    ctx.textAlign  = 'right';
    ctx.fillText(Math.round(val * 10) / 10, PAD.left - 6, y + 4);
  }

  // ── Axes ───────────────────────────────────────────────────
  ctx.strokeStyle = '#0d0d0d';
  ctx.lineWidth   = 2;
  ctx.beginPath();
  ctx.moveTo(PAD.left, PAD.top);
  ctx.lineTo(PAD.left, PAD.top + innerH);
  ctx.lineTo(PAD.left + innerW, PAD.top + innerH);
  ctx.stroke();

  // ── Fill area ──────────────────────────────────────────────
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(data[0]));
  data.forEach((v, i) => { if (i > 0) ctx.lineTo(toX(i), toY(v)); });
  ctx.lineTo(toX(data.length - 1), PAD.top + innerH);
  ctx.lineTo(toX(0), PAD.top + innerH);
  ctx.closePath();
  ctx.fillStyle = cfg.color + '22';
  ctx.fill();

  // ── Line ───────────────────────────────────────────────────
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(data[0]));
  data.forEach((v, i) => { if (i > 0) ctx.lineTo(toX(i), toY(v)); });
  ctx.strokeStyle = cfg.color;
  ctx.lineWidth   = 2.5;
  ctx.lineJoin    = 'round';
  ctx.stroke();

  // ── Dots ───────────────────────────────────────────────────
  data.forEach((v, i) => {
    if (i % 2 !== 0 && i !== data.length - 1) return;
    ctx.beginPath();
    ctx.arc(toX(i), toY(v), i === data.length - 1 ? 5 : 3, 0, Math.PI * 2);
    ctx.fillStyle   = i === data.length - 1 ? cfg.color : '#fff';
    ctx.strokeStyle = cfg.color;
    ctx.lineWidth   = 2;
    ctx.fill();
    ctx.stroke();

    if (i === data.length - 1) {
      ctx.fillStyle = '#0d0d0d';
      ctx.font      = "bold 11px 'Space Mono', monospace";
      ctx.textAlign = 'center';
      const label = key === 'ldr' ? (v === 1 ? 'TRG' : 'GLP') : v;
      ctx.fillText(label, toX(i), toY(v) - 10);
    }
  });

  // ── X tick labels ──────────────────────────────────────────
  ctx.fillStyle = '#888';
  ctx.font      = "bold 9px 'Space Mono', monospace";
  ctx.textAlign = 'center';
  const every   = Math.ceil(HISTORY_LEN / 5);
  data.forEach((_, i) => {
    if (i % every === 0 || i === data.length - 1) {
      ctx.fillText(i + 1, toX(i), PAD.top + innerH + 16);
    }
  });
}

// ══════════════════════════════════════════
//   LOG TABLE
// ══════════════════════════════════════════
function updateLog() {
  const tbody = $('log-body');
  if (!state.log.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#aaa;padding:20px">Menunggu data dari ESP32…</td></tr>';
    return;
  }
  tbody.innerHTML = state.log.slice(0, 10).map((row, i) => {
    const sc    = statusTdClass(row.status);
    const ldrTx = row.ldr === null ? '--' : (row.ldr === 1 ? 'TERANG' : 'GELAP');
    return `<tr>
      <td>${i + 1}</td>
      <td>${fmtTime(row.time)}</td>
      <td>${row.temp ?? '--'}</td>
      <td>${row.hum  ?? '--'}</td>
      <td>${ldrTx}</td>
      <td class="${sc}">${row.status}</td>
    </tr>`;
  }).join('');
}

// ══════════════════════════════════════════
//   CLOCK
// ══════════════════════════════════════════
function updateClock() {
  $('header-time').textContent = fmtTime(new Date());
}

// ══════════════════════════════════════════
//   FOOTER TIMESTAMP
// ══════════════════════════════════════════
function updateFooter() {
  $('last-update').textContent = 'Terakhir diperbarui: ' + fmtTime(new Date());
}

// ══════════════════════════════════════════
//   CSV EXPORT
// ══════════════════════════════════════════
function exportCSV() {
  if (!state.log.length) { showToast('⚠️ Belum ada data untuk diekspor!'); return; }
  const header = ['No', 'Waktu', 'Suhu (°C)', 'Kelembaban (%)', 'Cahaya (LDR)', 'Status'];
  const rows   = state.log.map((row, i) =>
    [i + 1, fmtTime(row.time), row.temp, row.hum,
     row.ldr === 1 ? 'TERANG' : 'GELAP', row.status].join(',')
  );
  const csv  = [header.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'sensorwatch_log.csv';
  a.click();
  URL.revokeObjectURL(url);
  showToast('📥 Data berhasil diekspor!');
}

// ══════════════════════════════════════════
//   LED / RELAY CONTROL
// ══════════════════════════════════════════
const LED_COLORS = {
  1: '#ff4444',
  2: '#3d7eff',
  3: '#00d4a0',
  4: '#ffd400',
};

const ledState = { 1: false, 2: false, 3: false, 4: false };

/**
 * @param {1|2|3|4} id
 * @param {boolean}  on
 * @param {'user'|'mqtt'|null} source
 */
function setLed(id, on, source) {
  ledState[id] = on;
  const card  = $('led-card-' + id);
  const stEl  = $('led-state-' + id);
  const btn   = $('led-btn-'   + id);

  if (on) {
    card.classList.add('is-on');
    stEl.textContent = 'MENYALA';
    btn.setAttribute('aria-pressed', 'true');
  } else {
    card.classList.remove('is-on');
    stEl.textContent = 'MATI';
    btn.setAttribute('aria-pressed', 'false');
  }

  // Hanya kirim MQTT jika user yang memencet (bukan update dari ESP32)
  if (source === 'user') {
    mqttService.setRelay(id, on);
    const name = `Relay ${id}`;
    showToast(on ? `💡 ${name} dinyalakan` : `🌑 ${name} dimatikan`);
  }
}

function initLedControls() {
  // Toggle individual
  document.querySelectorAll('.led-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      if (state.mode === 'AUTO') {
        showToast('⚙️ Mode AUTO aktif — kontrol manual dinonaktifkan', 2000);
        return;
      }
      const id = parseInt(btn.dataset.led, 10);
      setLed(id, !ledState[id], 'user');
    });
  });

  // Semua ON
  $('btn-all-on').addEventListener('click', () => {
    if (state.mode === 'AUTO') { showToast('⚙️ Mode AUTO aktif', 2000); return; }
    mqttService.allOn();
    [1,2,3,4].forEach(id => setLed(id, true, null));
    showToast('💡 Semua Relay dinyalakan!');
  });

  // Semua OFF
  $('btn-all-off').addEventListener('click', () => {
    if (state.mode === 'AUTO') { showToast('⚙️ Mode AUTO aktif', 2000); return; }
    mqttService.allOff();
    [1,2,3,4].forEach(id => setLed(id, false, null));
    showToast('🌑 Semua Relay dimatikan!');
  });

  // Toggle AUTO / MANUAL
  $('btn-mode').addEventListener('click', () => {
    const newAuto = state.mode !== 'AUTO';
    mqttService.setMode(newAuto);
    applyMode(newAuto ? 'AUTO' : 'MANUAL');
    showToast(newAuto ? '🤖 Mode AUTO diaktifkan' : '⚙ Mode MANUAL diaktifkan');
  });
}



// ══════════════════════════════════════════
//   CHART TABS
// ══════════════════════════════════════════
function initChartTabs() {
  document.querySelectorAll('.ctab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ctab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeChart = btn.dataset.sensor;
      drawChart();
    });
  });
}

// ══════════════════════════════════════════
//   INIT
// ══════════════════════════════════════════
function init() {
  initChart();
  initChartTabs();
  initLedControls();

  $('btn-export').addEventListener('click', exportCSV);

  // Close Warning Modal
  const closeBtn = $('warning-close-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      $('warning-modal').classList.remove('show');
    });
  }

  // Logout
  const btnLogout = $('btn-logout');
  if (btnLogout) {
    btnLogout.addEventListener('click', () => {
      try { sessionStorage.removeItem('isLoggedIn'); } catch(e){}
      window.location.href = 'login.html';
    });
  }

  // Clock: setiap detik
  setInterval(updateClock, 1000);
  updateClock();

  // Render awal (kosong)
  updateCards();
  updateLog();
  drawChart();
  applyMode('MANUAL');

  // ── MQTT ──────────────────────────────────────────────────
  mqttService
    .on('connect', () => {
      updateConnectionStatus(true);
      showToast('🔌 Terhubung ke HiveMQ Cloud!', 3000);
    })
    .on('reconnect', () => {
      updateConnectionStatus(false);
    })
    .on('disconnect', () => {
      updateConnectionStatus(false);
      showToast('⚡ Koneksi MQTT terputus — mencoba reconnect…', 3500);
    })
    .on('error', (err) => {
      updateConnectionStatus(false);
      showToast('❌ MQTT Error: ' + err.message, 4000);
    })
    .on('sensor', (data) => {
      // Data real-time dari ESP32
      processIncomingData(data);
    });

  mqttService.connect();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
