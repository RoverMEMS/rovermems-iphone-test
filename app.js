'use strict';

// =====================================================================
// 定数（Android版 MemsProtocol.kt / MemsCommand.kt / BleEcuDataSource.kt と同じ値）
// =====================================================================

// ATOM Lite ファームの Nordic UART Service
const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // スマホ → ECU
const NUS_RX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // ECU → スマホ（通知）

const CMD = {
  INIT_A: 0xCA, INIT_B: 0x75, HEARTBEAT: 0xF4, ID_REQUEST: 0xD0,
  REQ_80: 0x80, REQ_7D: 0x7D, CLEAR_FAULTS: 0xCC,
};
const FRAME80_SIZE = 28;
const FRAME7D_SIZE = 32;
const ECHO_TIMEOUT_MS = 1500;
const FRAME_TIMEOUT_MS = 3000;
const GATT_CONNECT_TIMEOUT_MS = 8000;
const CONNECT_ATTEMPTS = 3;
const CONNECT_RETRY_DELAY_MS = 1000;
// セル中にATOM LiteのACC電源が落ちて切れる → 最長60秒、1.5秒おきにつなぎ直す
const AUTO_RECONNECT_WINDOW_MS = 60000;
const AUTO_RECONNECT_INTERVAL_MS = 1500;
const POLL_FAILS_BEFORE_RECONNECT = 3;
// 0x7D（ラムダ・燃料トリム等）は0x80ほど速く変わらないので2回に1回だけ取り、
// メーターに使う0x80の更新を速くする（iPhone実車で両方毎回だと毎秒2.3回だった）
const FRAME7D_EVERY = 2;
const TEMP_OFFSET_C = 55;
const FUEL_TRIM_CENTER = 128;
const KNOWN_ECU_IDS = { '9A 00 02 02': 'MEMS 1.3 検出' };

// =====================================================================
// 表示項目（文言は Android版 strings.xml と同じ）
// =====================================================================

const METRICS = {
  rpm: {
    label: 'RPM', fmt: (d) => `${d.rpm}`,
    desc: 'エンジンの回転数(1分間あたりの回転数)です。',
    range: '目安: アイドリング中は750〜1000rpm程度',
  },
  map: {
    label: 'MAP(kPa)', fmt: (d) => `${d.map}`,
    desc: '吸気マニホールド内の圧力です。数値が低いほど負圧(スロットルが閉じている)、大気圧(約100kPa)に近いほどアクセル全開に近い状態です。',
    range: '目安: アイドリング中は25〜45kPa、全開付近で90kPa以上',
  },
  tps: {
    label: 'TPS(V)', fmt: (d) => d.tpsV.toFixed(2),
    desc: 'スロットルポジションセンサー(アクセル開度)の電圧です。',
    range: '目安: アクセルを離した状態で0.3〜0.7V、全開でおよそ4.0V以上',
  },
  coolant: {
    label: '水温(C)', fmt: (d) => `${d.coolant}`,
    desc: 'エンジン冷却水の温度です。',
    range: '目安: 暖機完了後は80〜105°C。それを大きく超える場合はオーバーヒートの兆候です。',
  },
  intake: {
    label: '吸気温(C)', fmt: (d) => `${d.intake}`,
    desc: 'エンジンに吸い込む空気の温度です。外気温+エンジン熱の影響を受けます。',
    range: '目安: 外気温〜外気温+30°C程度',
  },
  battery: {
    label: 'Bat(V)', fmt: (d) => d.battery.toFixed(2),
    desc: 'バッテリー電圧です。エンジン停止中と始動中で目安が変わります。',
    range: '目安: エンジン停止中12.0〜12.8V、始動中(充電中)13.5〜14.8V',
  },
  ignition: {
    label: '点火進角', fmt: (d) => d.ignition.toFixed(1),
    desc: '点火タイミング(上死点より何度手前で点火するか)です。回転数や負荷で変動します。',
    range: '目安: アイドリング中は5〜15°程度',
  },
  lambda: {
    label: 'Lambda(mV)', fmt: (d) => (d.lambdaMv == null ? '--' : `${d.lambdaMv}`),
    desc: 'O2(酸素)センサーの電圧です。クローズドループ制御中は0〜1000mVの間で細かく上下に振れるのが正常です。',
    range: '目安: 平均でおよそ450mV付近を振れながら変動',
  },
  fuelTrim: {
    label: '燃料トリム(%)', fmt: (d) => (d.ltft == null ? '--' : signed(d.ltft)),
    desc: 'ECUが基本の燃料噴射量をどれだけ補正しているかです。0%が「補正なし」の基準値で、プラスは燃料を足している(薄い)、マイナスは燃料を減らしている(濃い)方向です。',
    range: '目安: ±10%以内。±25%を超える場合は燃料系統やO2センサーの点検をおすすめします。',
  },
};

// アナログメーター。目盛りの補正値は Android版 GaugeScreen.kt の実測値と同じ
const DIALS = {
  rpm: {
    face: 'img/rpm.webp', min: 0, max: 8000, value: (d) => d.rpm, text: (d) => `${d.rpm} rpm`,
    scale: [[0, -0.0367], [1000, 0.1000], [2000, 0.2408], [3000, 0.3692], [4000, 0.5008],
      [5000, 0.6336], [6000, 0.7649], [7000, 0.8940], [8000, 1.0325]],
    box: { top: 0.629, h: 0.076, w: 0.29 },
  },
  coolant: {
    face: 'img/coolant.webp', min: 40, max: 120, value: (d) => d.coolant, text: (d) => `${d.coolant} °C`,
    scale: [[40, 0], [120, 1]],
    box: { top: 0.648, h: 0.095, w: 0.27 },
  },
  battery: {
    face: 'img/battery.webp', min: 8, max: 16, value: (d) => d.battery, text: (d) => `${d.battery.toFixed(1)} V`,
    scale: [[8, 0.0478], [10, 0.2637], [11, 0.3700], [11.5, 0.4341], [12, 0.4998], [12.5, 0.5606],
      [13, 0.6275], [13.5, 0.6890], [14, 0.7538], [14.5, 0.8136], [15, 0.8735], [16, 0.9605]],
    box: { top: 0.629, h: 0.076, w: 0.21 },
  },
  map: {
    face: 'img/map.webp', min: 0, max: 100, value: (d) => d.map, text: (d) => `${d.map} kPa`,
    scale: [[0, -0.0031], [40, 0.3829], [50, 0.4978], [60, 0.6146], [70, 0.7285],
      [80, 0.8503], [90, 0.9633], [100, 1.0680]],
    box: { top: 0.629, h: 0.076, w: 0.21 },
  },
};
// 背景タップ／⇆ボタンで A面（回転計+水温）⇔ B面（電圧計+MAP）を入れ替える
const DIAL_SIDES = [['rpm', 'coolant'], ['battery', 'map']];
const DIAL_START_DEG = 150;
const DIAL_SWEEP_DEG = 240;

const FAULTS = [
  { key: 'coolant', lamp: '水温', label: '水温センサーエラー' },
  { key: 'intake', lamp: '吸気', label: '吸気温度センサーエラー' },
  { key: 'fuelPump', lamp: '燃料', label: '燃料ポンプ回路エラー' },
  { key: 'throttle', lamp: 'スロットル', label: 'スロットルポット回路エラー' },
];

// =====================================================================
// 小物
// =====================================================================

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function signed(n) { return (n > 0 ? '+' : '') + n; }
function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}
function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch (e) { /* 保存できない環境でも動くようにする */ }
  return null;
}
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// ---------- 診断用の記録 ----------
const t0 = performance.now();
const logLines = [];
let rawLogging = false;
function log(msg) {
  const line = `${((performance.now() - t0) / 1000).toFixed(3).padStart(8, ' ')}  ${msg}`;
  logLines.push(line);
  if (logLines.length > 3000) logLines.splice(0, 1000);
  const el = $('log');
  if ($('diag').open) {
    el.textContent += line + '\n';
    if (el.textContent.length > 80000) el.textContent = logLines.slice(-500).join('\n') + '\n';
    el.scrollTop = el.scrollHeight;
  }
}

// =====================================================================
// Bluetooth の送受信
// =====================================================================

let device = null;
let txChar = null;
let rxChar = null;
let rxBuf = [];
let waiter = null;

function onNotify(event) {
  const dv = event.target.value;
  const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  for (const b of bytes) rxBuf.push(b);
  if (rawLogging) log(`← ${hex(bytes)}`);
  if (waiter && rxBuf.length >= waiter.n) {
    const w = waiter;
    waiter = null;
    clearTimeout(w.timer);
    w.resolve(rxBuf.splice(0, w.n));
  }
}
function readExactly(n, timeoutMs) {
  return new Promise((resolve) => {
    if (rxBuf.length >= n) { resolve(rxBuf.splice(0, n)); return; }
    const timer = setTimeout(() => { waiter = null; resolve(null); }, timeoutMs);
    waiter = { n, resolve, timer };
  });
}
function abortRead() {
  if (waiter) {
    const w = waiter;
    waiter = null;
    clearTimeout(w.timer);
    w.resolve(null);
  }
}
function flushStale() {
  if (rxBuf.length) {
    log(`（読み捨て: ${hex(rxBuf)}）`);
    rxBuf = [];
  }
}
async function write(bytes) {
  const data = new Uint8Array(bytes);
  if (rawLogging) log(`→ ${hex(data)}`);
  // ファームは応答なし書き込み(WRITE_NR)前提
  if (txChar.writeValueWithoutResponse) await txChar.writeValueWithoutResponse(data);
  else await txChar.writeValue(data);
}
async function sendCommand(cmd) {
  flushStale();
  try {
    await write([cmd]);
  } catch (e) {
    log(`✗ ${hex([cmd])} 送信失敗: ${e.message}`);
    return false;
  }
  const echo = await readExactly(1, ECHO_TIMEOUT_MS);
  if (!echo) { log(`✗ ${hex([cmd])} のエコーが返らない`); return false; }
  if (echo[0] !== cmd) { log(`✗ ${hex([cmd])} のエコーが違う: ${hex(echo)}`); return false; }
  return true;
}
async function requestFrame(cmd, size) {
  if (!(await sendCommand(cmd))) return null;
  const frame = await readExactly(size, FRAME_TIMEOUT_MS);
  if (!frame) log(`✗ ${hex([cmd])} のデータが届かない`);
  return frame;
}

async function openGatt() {
  const tStart = performance.now();
  let server;
  try {
    server = await withTimeout(device.gatt.connect(), GATT_CONNECT_TIMEOUT_MS, 'Bluetooth接続がタイムアウト');
  } catch (e) {
    try { device.gatt.disconnect(); } catch (e2) { /* 無視 */ }
    throw e;
  }
  const service = await server.getPrimaryService(NUS_SERVICE);
  txChar = await service.getCharacteristic(NUS_TX);
  if (rxChar) rxChar.removeEventListener('characteristicvaluechanged', onNotify);
  rxChar = await service.getCharacteristic(NUS_RX);
  rxChar.addEventListener('characteristicvaluechanged', onNotify);
  await rxChar.startNotifications();
  rxBuf = [];
  log(`Bluetooth接続 ${Math.round(performance.now() - tStart)}ms`);
}

// MemsProtocol.initLink と同じ手順
async function initLink() {
  const prevRaw = rawLogging;
  rawLogging = true; // 初期化中は常に全部記録
  const tStart = performance.now();
  try {
    if (!(await sendCommand(CMD.INIT_A))) return null;
    if (!(await sendCommand(CMD.INIT_B))) return null;
    if (!(await sendCommand(CMD.HEARTBEAT))) return null;
    // F4 のエコーの後に1バイト来る（本来 00）。来なくても先へ進む
    if (!(await readExactly(1, 1000))) log('△ F4 の後の1バイトが来なかった（続行）');
    if (!(await sendCommand(CMD.ID_REQUEST))) return null;
    const id = await readExactly(4, FRAME_TIMEOUT_MS);
    if (!id) { log('✗ ECUの型番応答が来ない'); return null; }
    log(`✓ 初期化成功 ${Math.round(performance.now() - tStart)}ms　型番 ${hex(id)}`);
    return hex(id);
  } finally {
    rawLogging = prevRaw;
  }
}

// =====================================================================
// 受け取ったデータの変換（Android版 MemsData.fromFrames と同じ）
// =====================================================================

function parseFrames(f80, f7d) {
  const d = {
    rpm: (f80[1] << 8) | f80[2],
    coolant: f80[3] - TEMP_OFFSET_C,
    intake: f80[5] - TEMP_OFFSET_C,
    map: f80[7],
    battery: f80[8] / 10,
    tpsV: f80[9] * 0.02,
    parkNeutral: f80[12] !== 0,
    faults: {
      coolant: (f80[13] & 0x01) !== 0,
      intake: (f80[13] & 0x02) !== 0,
      fuelPump: (f80[14] & 0x02) !== 0,
      throttle: (f80[14] & 0x80) !== 0,
    },
    // アイドルスイッチは offset 18 の bit4（MemsData.kt のコメント参照）
    idleSwitch: (f80[18] & 0x10) !== 0,
    iac: f80[18],
    idleDeviation: (f80[19] << 8) | f80[20],
    ignition: f80[22] * 0.5 - 24,
    coilMs: ((f80[23] << 8) | f80[24]) * 0.002,
    throttleAngle: null, afr: null, lambdaMv: null, lambdaFreq: null, lambdaDuty: null,
    lambdaStatus: null, closedLoop: null, ltft: null, stft: null, canister: null,
    idleBase: null, idleError: null,
  };
  if (f7d) {
    Object.assign(d, {
      throttleAngle: f7d[2] * 0.6,
      afr: f7d[4] / 10,
      lambdaMv: f7d[6] * 5,
      lambdaFreq: f7d[7],
      lambdaDuty: f7d[8],
      lambdaStatus: f7d[9] !== 0,
      closedLoop: f7d[10] !== 0,
      ltft: f7d[11] - FUEL_TRIM_CENTER,
      stft: f7d[12],
      canister: f7d[13],
      idleBase: f7d[15],
      idleError: f7d[20],
    });
  }
  return d;
}

// =====================================================================
// 接続の流れ（接続 → 初期化 → データ取得 → 切れたら自動つなぎ直し）
// =====================================================================

let session = 0; // 切断・デモ開始などで増やし、古いループを止める
let userStopped = true;
let ecuId = null;
let pendingClear = null;
let demoTimer = null;

async function establish(my, attempts) {
  for (let a = 1; a <= attempts; a++) {
    if (my !== session) return false;
    try {
      if (!device.gatt.connected) await openGatt();
    } catch (e) {
      log(`✗ Bluetooth接続失敗: ${e.message}`);
      if (a < attempts) await sleep(CONNECT_RETRY_DELAY_MS);
      continue;
    }
    if (my !== session) return false;
    const id = await initLink();
    if (id) { ecuId = id; return true; }
    if (a < attempts) await sleep(CONNECT_RETRY_DELAY_MS);
  }
  return false;
}

async function pollLoop(my) {
  let fails = 0;
  let cycle = 0;
  let last7d = null;
  let rateCount = 0;
  let rateStart = performance.now();
  setState('connected');
  while (my === session) {
    if (pendingClear) {
      const resolve = pendingClear;
      pendingClear = null;
      const ok = (await sendCommand(CMD.CLEAR_FAULTS)) && (await readExactly(1, ECHO_TIMEOUT_MS)) !== null;
      log(ok ? '✓ エラークリア' : '✗ エラークリア失敗');
      resolve(ok);
    }
    if (!device.gatt.connected) return;
    const f80 = await requestFrame(CMD.REQ_80, FRAME80_SIZE);
    let ok = f80 !== null;
    if (ok && (cycle % FRAME7D_EVERY === 0 || !last7d)) {
      const f7d = await requestFrame(CMD.REQ_7D, FRAME7D_SIZE);
      if (f7d) last7d = f7d; else ok = false;
    }
    if (my !== session) return;
    if (!ok) {
      fails++;
      if (fails >= POLL_FAILS_BEFORE_RECONNECT || !device.gatt.connected) return;
      continue;
    }
    fails = 0;
    cycle++;
    render(parseFrames(f80, last7d));
    rateCount++;
    if (rateCount === 20) {
      const perSec = 20000 / (performance.now() - rateStart);
      $('rateNote').textContent = `更新: 毎秒 ${perSec.toFixed(1)} 回`;
      log(`更新 毎秒 ${perSec.toFixed(1)} 回`);
      rateCount = 0;
      rateStart = performance.now();
    }
  }
}

async function reconnectLoop(my) {
  const deadline = performance.now() + AUTO_RECONNECT_WINDOW_MS;
  while (performance.now() < deadline) {
    await sleep(AUTO_RECONNECT_INTERVAL_MS);
    if (my !== session) return false;
    log('つなぎ直し中…');
    if (await establish(my, 1)) {
      log('✓ つなぎ直し成功');
      return true;
    }
  }
  log('✗ 60秒たってもつながらないので諦めました');
  return false;
}

async function runBle() {
  const my = ++session;
  userStopped = false;
  setState('connecting');
  acquireWakeLock();
  if (!(await establish(my, CONNECT_ATTEMPTS))) {
    if (my === session) failConnection('接続に失敗しました。配線・電源・ECUの状態を確認してもう一度お試しください。');
    return;
  }
  while (my === session) {
    await pollLoop(my);
    if (my !== session) return;
    setState('reconnecting');
    if (!(await reconnectLoop(my))) {
      if (my === session) failConnection('接続が切れました。キーがONになっているか確認して、もう一度つないでください。');
      return;
    }
  }
}

function failConnection(message) {
  session++;
  resolvePendingClear(false);
  releaseWakeLock();
  try { if (device && device.gatt.connected) device.gatt.disconnect(); } catch (e) { /* 無視 */ }
  setState('error', message);
}

function onGattDisconnected() {
  log('Bluetoothが切断されました');
  if (!userStopped) abortRead(); // 待っている読み込みをすぐ終わらせて、つなぎ直しへ
}

async function chooseDeviceAndConnect() {
  let picked;
  try {
    picked = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'RoverMEMS' }],
      optionalServices: [NUS_SERVICE],
    });
  } catch (e) {
    if (e.name !== 'NotFoundError') {
      log(`エラー: ${e.name} ${e.message}`);
      setState('error', `Bluetoothのエラー: ${e.message}`);
    }
    return;
  }
  if (device && device !== picked) device.removeEventListener('gattserverdisconnected', onGattDisconnected);
  if (device !== picked) picked.addEventListener('gattserverdisconnected', onGattDisconnected);
  device = picked;
  log(`機器: ${device.name}`);
  runBle();
}

function stopAll() {
  userStopped = true;
  session++;
  abortRead();
  resolvePendingClear(false);
  if (demoTimer) { clearInterval(demoTimer); demoTimer = null; }
  try { if (device && device.gatt.connected) device.gatt.disconnect(); } catch (e) { /* 無視 */ }
  releaseWakeLock();
  setState('idle');
}

function resolvePendingClear(value) {
  if (pendingClear) { pendingClear(value); pendingClear = null; }
}
function clearFaults() {
  if (state === 'demo') return Promise.resolve(true);
  if (state !== 'connected') return Promise.resolve(false);
  return new Promise((resolve) => { pendingClear = resolve; });
}

// ---------- 画面を消さない（運転中に見るため） ----------
let wakeLock = null;
async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { /* 対応していないブラウザでは何もしない */ }
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ['connected', 'connecting', 'reconnecting', 'demo'].includes(state)) {
    acquireWakeLock();
  }
});

// =====================================================================
// デモモード（Android版 MockEcuDataSource と同じく、実車なしで画面を試す）
// =====================================================================

function startDemo() {
  stopAll();
  const my = ++session;
  setState('demo');
  acquireWakeLock();
  const start = performance.now();
  demoTimer = setInterval(() => {
    if (my !== session) return;
    const t = (performance.now() - start) / 1000;
    // 20秒周期: 0〜8秒アイドル → 8〜14秒で空ぶかし → 14〜20秒で戻る
    const phase = t % 20;
    let rev = 0;
    if (phase >= 8 && phase < 11) rev = (phase - 8) / 3;
    else if (phase >= 11 && phase < 14) rev = 1;
    else if (phase >= 14 && phase < 17) rev = 1 - (phase - 14) / 3;
    const wobble = Math.sin(t * 2.3) * 25;
    const rpm = Math.round(860 + wobble + rev * 2400);
    const coolant = Math.round(Math.min(88, 62 + t * 0.6));
    const tpsV = 0.56 + rev * 1.4;
    render({
      rpm, coolant, intake: 34 + Math.round(t * 0.05) % 3, map: Math.round(34 + rev * 30 + Math.sin(t) * 1.5),
      battery: 14.1 + Math.sin(t * 0.7) * 0.08, tpsV, parkNeutral: false,
      faults: { coolant: false, intake: false, fuelPump: false, throttle: false },
      idleSwitch: rev === 0, iac: 45, idleDeviation: Math.round(wobble), ignition: 12 + rev * 18,
      coilMs: 3.2, throttleAngle: rev * 40, afr: 14.7, lambdaMv: Math.round(450 + Math.sin(t * 5) * 380),
      lambdaFreq: 12, lambdaDuty: 50, lambdaStatus: true, closedLoop: rev === 0, ltft: 2, stft: 0,
      canister: 0, idleBase: 30, idleError: 0,
    });
  }, 250);
}

// =====================================================================
// 画面
// =====================================================================

let state = 'idle';
let view = store('view') || 'analog';
let dialSide = Number(store('dialSide')) === 1 ? 1 : 0;
let lastData = null;

function setState(next, message) {
  state = next;
  const badge = $('badge');
  const labels = {
    idle: ['未接続', ''],
    connecting: ['接続中…', 'warn'],
    connected: [KNOWN_ECU_IDS[ecuId] || `MEMS 接続済み(ID: ${ecuId})`, 'ok'],
    reconnecting: ['再接続中…', 'warn'],
    error: ['接続エラー', 'ng'],
    demo: ['デモモード', 'demo'],
  };
  badge.textContent = labels[next][0];
  badge.className = 'badge ' + labels[next][1];

  const live = next !== 'idle' && next !== 'error';
  $('tabs').hidden = !live;
  $('btnStop').hidden = !live;
  $('btnStop').textContent = next === 'demo' ? '終了' : '切断';
  $('connectMsg').hidden = !message;
  $('connectMsg').textContent = message || '';
  $('btnReconnect').hidden = !(next === 'error' && device);
  $('btnConnect').textContent = next === 'error' && device ? '別のアダプターを選ぶ' : 'Bluetoothで接続';
  if (next === 'idle' || next === 'error') lastData = null;
  showView(live ? view : 'connect');
}

function showView(name) {
  const sections = { connect: 'viewConnect', analog: 'viewAnalog', simple: 'viewSimple', detail: 'viewDetail' };
  for (const [key, id] of Object.entries(sections)) $(id).hidden = key !== name;
  document.body.classList.toggle('mode-analog', name === 'analog');
  for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('active', b.dataset.view === name);
  if (name !== 'connect') {
    view = name;
    store('view', name);
  }
  if (lastData) render(lastData);
}

function dialAngle(dial, v) {
  const pts = dial.scale;
  const clamped = Math.min(Math.max(v, pts[0][0]), pts[pts.length - 1][0]);
  let i = 0;
  while (i < pts.length - 2 && clamped > pts[i + 1][0]) i++;
  const [v0, f0] = pts[i];
  const [v1, f1] = pts[i + 1];
  const frac = f0 + ((clamped - v0) / (v1 - v0 || 1)) * (f1 - f0);
  return DIAL_START_DEG + frac * DIAL_SWEEP_DEG;
}

function setupDials() {
  DIAL_SIDES[dialSide].forEach((key, slot) => {
    const dial = DIALS[key];
    const el = $(`gauge${slot}`);
    el.querySelector('.face').src = dial.face;
    const box = el.querySelector('.digital');
    box.style.top = `${dial.box.top * 100}%`;
    box.style.height = `${dial.box.h * 100}%`;
    box.style.width = `${dial.box.w * 100}%`;
    box.style.fontSize = `${dial.box.h * 80}cqw`;
    el.querySelector('.digital span').textContent = '--';
    el.querySelector('.needle').style.setProperty('--rot', `${dialAngle(dial, dial.min) - 270}deg`);
  });
}
function flipDials() {
  dialSide = 1 - dialSide;
  store('dialSide', String(dialSide));
  setupDials();
  if (lastData) render(lastData);
}

function hasFault(d) { return FAULTS.some((f) => d.faults[f.key]); }

function renderBanner(el, d) {
  const bad = hasFault(d);
  el.textContent = bad ? 'センサーエラー・詳細を確認' : 'センサーエラーなし';
  el.className = 'banner' + (bad ? ' ng' : '');
}

function buildStatic() {
  // シンプル画面のカード
  const cards = $('cards');
  for (const [key, m] of Object.entries(METRICS)) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<div class="head"><span></span><button class="info" aria-label="説明">？</button></div><div class="v" data-metric="${key}">--</div>`;
    card.querySelector('.head span').textContent = m.label;
    card.querySelector('.info').addEventListener('click', () => {
      $('infoTitle').textContent = m.label;
      $('infoDesc').textContent = m.desc;
      $('infoRange').textContent = m.range;
      $('infoDialog').showModal();
    });
    cards.appendChild(card);
  }
  // アナログ画面のエラーランプ
  for (const f of FAULTS) {
    const lamp = document.createElement('span');
    lamp.className = 'lamp';
    lamp.dataset.fault = f.key;
    lamp.innerHTML = '<i></i>';
    lamp.append(f.lamp);
    $('lamps').appendChild(lamp);
  }
}

function detailRows(d) {
  const onOff = (b) => (b == null ? '--' : b ? '有効' : '無効');
  const num = (v, digits, unit) => (v == null ? '--' : `${digits == null ? v : v.toFixed(digits)}${unit || ''}`);
  return [
    ['回転数', `${d.rpm} rpm`],
    ['水温', `${d.coolant} °C`],
    ['吸気温度', `${d.intake} °C`],
    ['MAP', `${d.map} kPa`],
    ['スロットル電圧', `${d.tpsV.toFixed(2)} V`],
    ['スロットル開度', num(d.throttleAngle, 0, ' °')],
    ['アイドル回転偏差', `${d.idleDeviation}`],
    ['ラムダ電圧', num(d.lambdaMv, null, ' mV')],
    ['IACポジション', `${d.iac}`],
    ['バッテリー電圧', `${d.battery.toFixed(2)} V`],
    ['空燃比', num(d.afr, 1)],
    ['ラムダセンサー周波数', num(d.lambdaFreq)],
    ['ラムダセンサーデューティ比', num(d.lambdaDuty)],
    ['ラムダセンサー状態', onOff(d.lambdaStatus)],
    ['クローズドループ', onOff(d.closedLoop)],
    ['アイドルベース位置', num(d.idleBase)],
    ['アイドルエラー', num(d.idleError)],
    ['点火進角', `${d.ignition.toFixed(1)} °`],
    ['燃料トリム(長期)', d.ltft == null ? '--' : signed(d.ltft)],
    ['燃料トリム(短期)', d.stft == null ? '--' : signed(d.stft)],
    ['キャニスターパージデューティ比', num(d.canister)],
    ['アイドルスイッチ', d.idleSwitch ? 'ON' : 'OFF'],
    ['パーキング/ニュートラルスイッチ', d.parkNeutral ? 'ON' : 'OFF'],
    ['コイル時間', `${Math.round(d.coilMs * 1000)} µs`],
  ];
}

function fillTable(table, rows, cellClass) {
  if (table.rows.length !== rows.length) {
    table.innerHTML = '';
    for (let i = 0; i < rows.length; i++) table.insertRow().append(document.createElement('td'), document.createElement('td'));
  }
  rows.forEach(([label, value, cls], i) => {
    const [a, b] = table.rows[i].cells;
    if (a.textContent !== label) a.textContent = label;
    if (b.textContent !== value) b.textContent = value;
    b.className = cls || cellClass || '';
  });
}

function render(d) {
  lastData = d;
  if (view === 'analog' && !$('viewAnalog').hidden) {
    DIAL_SIDES[dialSide].forEach((key, slot) => {
      const dial = DIALS[key];
      const el = $(`gauge${slot}`);
      el.querySelector('.needle').style.setProperty('--rot', `${dialAngle(dial, dial.value(d)) - 270}deg`);
      el.querySelector('.digital span').textContent = dial.text(d);
    });
    for (const lamp of $('lamps').children) lamp.classList.toggle('on', d.faults[lamp.dataset.fault]);
  } else if (view === 'simple' && !$('viewSimple').hidden) {
    renderBanner($('bannerSimple'), d);
    for (const el of $('cards').querySelectorAll('.v')) el.textContent = METRICS[el.dataset.metric].fmt(d);
  } else if (view === 'detail' && !$('viewDetail').hidden) {
    renderBanner($('bannerDetail'), d);
    fillTable($('detailRows'), detailRows(d));
    fillTable($('faultRows'), FAULTS.map((f) => [
      f.label, d.faults[f.key] ? 'エラーあり' : '正常', d.faults[f.key] ? 'fault-ng' : 'fault-ok',
    ]));
  }
}

// ---------- ボタン ----------
function wireUi() {
  $('btnConnect').addEventListener('click', chooseDeviceAndConnect);
  $('btnReconnect').addEventListener('click', () => { if (device) runBle(); });
  $('btnDemo').addEventListener('click', startDemo);
  $('btnStop').addEventListener('click', () => { log('切断ボタン'); stopAll(); });
  for (const b of $('tabs').querySelectorAll('button')) b.addEventListener('click', () => showView(b.dataset.view));
  $('btnFlip').addEventListener('click', flipDials);
  // 木目の背景（メーター以外）をタップしても切り替え
  $('viewAnalog').addEventListener('click', (e) => {
    if (e.target === $('viewAnalog') || e.target === $('dials')) flipDials();
  });
  $('btnClearFaults').addEventListener('click', async () => {
    if (!confirm('ECUに記録されたエラーを消去します。よろしいですか？')) return;
    const btn = $('btnClearFaults');
    btn.disabled = true;
    const ok = await clearFaults();
    btn.disabled = false;
    alert(ok ? 'エラーコードをクリアしました' : 'クリアに失敗しました');
  });
  $('optRaw').addEventListener('change', (e) => { rawLogging = e.target.checked; });
  $('diag').addEventListener('toggle', () => {
    if ($('diag').open) {
      $('log').textContent = logLines.slice(-500).join('\n') + '\n';
      $('log').scrollTop = $('log').scrollHeight;
    }
  });
  $('btnCopyLog').addEventListener('click', async () => {
    const text = `${navigator.userAgent}\n${logLines.join('\n')}`;
    const btn = $('btnCopyLog');
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'コピーしました';
    } catch (e) {
      const range = document.createRange();
      range.selectNodeContents($('log'));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      btn.textContent = '選択しました（コピーしてください）';
    }
    setTimeout(() => { btn.textContent = '記録をコピー'; }, 2500);
  });
  $('btnClearLog').addEventListener('click', () => { logLines.length = 0; $('log').textContent = ''; });
}

function init() {
  buildStatic();
  setupDials();
  wireUi();
  if (!navigator.bluetooth) {
    $('supportNote').innerHTML = '<span class="ng">このブラウザはBluetoothに対応していません。iPhoneでは「Bluefy」、AndroidではChromeで開いてください。デモモードはこのままお試しいただけます。</span>';
    $('btnConnect').disabled = true;
  }
  setState('idle');
  log('ページ読み込み');
}

init();
