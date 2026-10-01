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
// 0x7D（ラムダ・燃料トリム等）は2回に1回だけ取り、メーターに使う0x80の更新を速くする
// （iPhone実車で両方毎回だと毎秒2.3回だった）
const FRAME7D_EVERY = 2;
const TEMP_OFFSET_C = 55;
const FUEL_TRIM_CENTER = 128;
const KNOWN_ECU_IDS = { '9A 00 02 02': 'MEMS 1.3 検出' };

// グラフ（GaugeViewModel.MAX_HISTORY_SIZE と同じ）
const MAX_HISTORY_SIZE = 150;
// ログ（DataLogger.kt / GaugeViewModel.kt と同じ）
const LOG_HEADER = '#time,engineSpeed,waterTemp,intakeAirTemp,throttleVoltage,'
  + 'manifoldPressure,idleBypassPos,mainVoltage,idleswitch,closedloop,lambdaVoltage_mV';
const MAX_LOG_FILES = 50;
const LOG_AUTO_STOP_AFTER_MS = 30000;
const LOG_FLUSH_INTERVAL_MS = 3000;
// 夜間モード（NightModeManager.kt と同じ時間帯）
const NIGHT_START_HOUR = 18;
const NIGHT_END_HOUR = 6;

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
    label: 'RPM', face: 'img/rpm.webp', min: 0, max: 8000, value: (d) => d.rpm, text: (d) => `${d.rpm} rpm`,
    scale: [[0, -0.0367], [1000, 0.1000], [2000, 0.2408], [3000, 0.3692], [4000, 0.5008],
      [5000, 0.6336], [6000, 0.7649], [7000, 0.8940], [8000, 1.0325]],
    box: { top: 0.629, h: 0.076, w: 0.29 },
  },
  coolant: {
    label: '水温(C)', face: 'img/coolant.webp', min: 40, max: 120, value: (d) => d.coolant, text: (d) => `${d.coolant} °C`,
    scale: [[40, 0], [120, 1]],
    box: { top: 0.648, h: 0.095, w: 0.27 },
  },
  battery: {
    label: 'Bat(V)', face: 'img/battery.webp', min: 8, max: 16, value: (d) => d.battery, text: (d) => `${d.battery.toFixed(1)} V`,
    scale: [[8, 0.0478], [10, 0.2637], [11, 0.3700], [11.5, 0.4341], [12, 0.4998], [12.5, 0.5606],
      [13, 0.6275], [13.5, 0.6890], [14, 0.7538], [14.5, 0.8136], [15, 0.8735], [16, 0.9605]],
    box: { top: 0.629, h: 0.076, w: 0.21 },
  },
  map: {
    label: 'MAP(kPa)', face: 'img/map.webp', min: 0, max: 100, value: (d) => d.map, text: (d) => `${d.map} kPa`,
    scale: [[0, -0.0031], [40, 0.3829], [50, 0.4978], [60, 0.6146], [70, 0.7285],
      [80, 0.8503], [90, 0.9633], [100, 1.0680]],
    box: { top: 0.629, h: 0.076, w: 0.21 },
  },
};
const DIAL_ORDER = ['rpm', 'coolant', 'battery', 'map'];
const DIAL_START_DEG = 150;
const DIAL_SWEEP_DEG = 240;
const SWIPE_THRESHOLD_PX = 56;

const FAULTS = [
  { key: 'coolant', icon: '🌡️', lamp: '水温', label: '水温センサーエラー' },
  { key: 'intake', icon: '💨', lamp: '吸気', label: '吸気温度センサーエラー' },
  { key: 'fuelPump', icon: '⛽', lamp: '燃料', label: '燃料ポンプ回路エラー' },
  { key: 'throttle', icon: '⚡', lamp: 'スロットル', label: 'スロットルポット回路エラー' },
];

// 接続中のグラフ（GaugeScreen.kt の ChartsView と同じ7項目）
const LIVE_CHARTS = [
  { label: '回転数(rpm)', value: (d) => d.rpm },
  { label: '水温(°C)', value: (d) => d.coolant },
  { label: '吸気温度(°C)', value: (d) => d.intake },
  { label: 'MAP(kPa)', value: (d) => d.map },
  { label: 'バッテリー電圧(V)', value: (d) => d.battery },
  { label: '点火進角(°)', value: (d) => d.ignition },
  { label: 'ラムダ電圧(mV)', value: (d) => d.lambdaMv },
];
// 保存したログのグラフ（LogChartScreen.kt / LogFileParser.kt と同じ列）
const LOG_COLUMNS = [
  ['engineSpeed', '回転数(rpm)'],
  ['waterTemp', '水温(°C)'],
  ['intakeAirTemp', '吸気温度(°C)'],
  ['throttleVoltage', 'スロットル電圧(V)'],
  ['manifoldPressure', 'MAP(kPa)'],
  ['idleBypassPos', 'IACポジション'],
  ['mainVoltage', 'バッテリー電圧(V)'],
  ['lambdaVoltage_mV', 'ラムダ電圧(mV)'],
];

// 部品テスト（Android版 ActuatorControls.kt / MemsCommand.kt と同じ）。
// MEMSFCRにある「Temperature Gauge」はコマンド値が未確認のため入れない
const ACTUATORS = [
  { label: '燃料ポンプ', on: 0x11, off: 0x01 },
  { label: 'マニホールドヒーター', on: 0x12, off: 0x02 },
  { label: 'エアコン', on: 0x13, off: 0x03 },
  { label: 'パージバルブ', on: 0x18, off: 0x08 },
  { label: 'ラムダヒーター', on: 0x19, off: 0x09 },
  // このミニはファンを水温スイッチで直接動かす配線で、ECUからは動かない（実車確認済み）
  { label: 'ファン1', on: 0x1D, off: 0x0D, unsupported: true },
  { label: 'ファン2', on: 0x1E, off: 0x0E, unsupported: true },
  { label: 'インジェクター', on: 0xF7 },
  { label: 'イグニッションコイル', on: 0xF8 },
];

// =====================================================================
// 小物
// =====================================================================

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n, w = 2) => String(n).padStart(w, '0');
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
let demoTimer = null;
// エラークリア・部品テストなど、データ取得の合間に送る1回きりのコマンド
const commandQueue = [];

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
    while (commandQueue.length && my === session) {
      const { cmd, label, resolve } = commandQueue.shift();
      // エラークリア・部品テストとも、エコーの後に1バイト返ってくる（MemsProtocol.kt と同じ）
      const ok = (await sendCommand(cmd)) && (await readExactly(1, ECHO_TIMEOUT_MS)) !== null;
      log(`${ok ? '✓' : '✗'} ${label}（${hex([cmd])}）`);
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
    onData(parseFrames(f80, last7d), true);
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
  if (state !== 'reconnecting') setState('connecting');
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
  failQueuedCommands();
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

// アナログ画面の再接続ボタン: 自動つなぎ直しの待ち時間を待たずに、すぐつなぎ直す
function reconnectNow() {
  if (!device || state === 'demo') return;
  log('手動でつなぎ直し');
  try { if (device.gatt.connected) device.gatt.disconnect(); } catch (e) { /* 無視 */ }
  setState('reconnecting');
  runBle();
}

function stopAll() {
  userStopped = true;
  session++;
  abortRead();
  failQueuedCommands();
  if (demoTimer) { clearInterval(demoTimer); demoTimer = null; }
  try { if (device && device.gatt.connected) device.gatt.disconnect(); } catch (e) { /* 無視 */ }
  releaseWakeLock();
  stopLogging();
  setState('idle');
}

function failQueuedCommands() {
  while (commandQueue.length) commandQueue.shift().resolve(false);
}
function queueCommand(cmd, label) {
  if (state === 'demo') { log(`（デモ）${label}`); return Promise.resolve(true); }
  if (state !== 'connected') return Promise.resolve(false);
  return new Promise((resolve) => { commandQueue.push({ cmd, label, resolve }); });
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
    onData({
      rpm: Math.round(860 + wobble + rev * 2400),
      coolant: Math.round(Math.min(88, 62 + t * 0.6)),
      intake: 34 + (Math.round(t * 0.05) % 3),
      map: Math.round(34 + rev * 30 + Math.sin(t) * 1.5),
      battery: 14.1 + Math.sin(t * 0.7) * 0.08,
      tpsV: 0.56 + rev * 1.4,
      parkNeutral: false,
      faults: { coolant: false, intake: false, fuelPump: false, throttle: false },
      idleSwitch: rev === 0, iac: 45, idleDeviation: Math.round(wobble), ignition: 12 + rev * 18,
      coilMs: 3.2, throttleAngle: rev * 40, afr: 14.7, lambdaMv: Math.round(450 + Math.sin(t * 5) * 380),
      lambdaFreq: 12, lambdaDuty: 50, lambdaStatus: true, closedLoop: rev === 0, ltft: 2, stft: 0,
      canister: 0, idleBase: 30, idleError: 0,
    }, false);
  }, 250);
}

// =====================================================================
// ログ記録（DataLogger.kt と同じCSV。iPhoneでは端末内のIndexedDBに保存）
// =====================================================================

let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('rovermems', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('logs', { keyPath: 'id' });
        db.createObjectStore('chunks', { autoIncrement: true }).createIndex('logId', 'logId');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    // 容量が足りなくなっても勝手に消されないようにお願いする（対応ブラウザのみ）
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* 無視 */ }
  }
  return dbPromise;
}
function txDone(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
function reqResult(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function listLogs() {
  const db = await openDb();
  const all = await reqResult(db.transaction('logs').objectStore('logs').getAll());
  return all.sort((a, b) => b.created - a.created);
}
async function readLogText(id) {
  const db = await openDb();
  const t = db.transaction('chunks');
  const chunks = await reqResult(t.objectStore('chunks').index('logId').getAll(IDBKeyRange.only(id)));
  return chunks.map((c) => c.text).join('');
}
async function deleteLog(id) {
  const db = await openDb();
  const t = db.transaction(['logs', 'chunks'], 'readwrite');
  t.objectStore('logs').delete(id);
  const keys = await reqResult(t.objectStore('chunks').index('logId').getAllKeys(IDBKeyRange.only(id)));
  for (const k of keys) t.objectStore('chunks').delete(k);
  await txDone(t);
}
async function enforceRetention() {
  const logs = await listLogs();
  for (const old of logs.slice(MAX_LOG_FILES)) await deleteLog(old.id);
}

const logger = { cur: null, buf: [], lastSampleAt: 0, writing: Promise.resolve() };

function formatClock(date, withMs) {
  const base = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return withMs ? `${base}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` : base;
}
function logFileName(date) {
  return `memsgauge_${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.csv`;
}
// Kotlin の Float と同じ書き方（14 → "14.0"、0.56 → "0.56"）
function floatText(x, digits) {
  const v = Number(x.toFixed(digits));
  return Number.isInteger(v) ? v.toFixed(1) : String(v);
}
// 実車のデータだけを記録する（デモは記録しない、Android版と同じ）
function logSample(d) {
  const now = new Date();
  if (!logger.cur) {
    logger.cur = { id: now.getTime(), name: logFileName(now), created: now.getTime(), updated: now.getTime(), size: 0 };
    logger.buf = [LOG_HEADER];
    log(`ログ記録開始 ${logger.cur.name}`);
    updateRecordingLine();
  }
  logger.lastSampleAt = Date.now();
  logger.buf.push([
    formatClock(now, true), d.rpm, d.coolant, d.intake, floatText(d.tpsV, 2), d.map, d.iac,
    floatText(d.battery, 1), d.idleSwitch, d.closedLoop ?? '', d.lambdaMv ?? '',
  ].join(','));
}
function flushLog() {
  const cur = logger.cur;
  if (!cur || !logger.buf.length) return logger.writing;
  const text = logger.buf.join('\n') + '\n';
  logger.buf = [];
  cur.size += text.length;
  cur.updated = Date.now();
  const meta = { ...cur };
  logger.writing = logger.writing.then(async () => {
    const db = await openDb();
    const t = db.transaction(['logs', 'chunks'], 'readwrite');
    t.objectStore('logs').put(meta);
    t.objectStore('chunks').add({ logId: meta.id, text });
    await txDone(t);
  }).catch((e) => log(`✗ ログ保存失敗: ${e.message}`));
  return logger.writing;
}
function stopLogging() {
  if (!logger.cur) return;
  const name = logger.cur.name;
  flushLog();
  logger.cur = null;
  logger.writing = logger.writing.then(enforceRetention).catch(() => {});
  log(`ログ記録終了 ${name}`);
  updateRecordingLine();
}
setInterval(() => {
  if (!logger.cur) return;
  flushLog();
  // 接続が30秒途切れたら記録を終える。セル中の一瞬の切断は同じファイルに続く
  if (Date.now() - logger.lastSampleAt > LOG_AUTO_STOP_AFTER_MS) stopLogging();
}, LOG_FLUSH_INTERVAL_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushLog();
  else if (['connected', 'connecting', 'reconnecting', 'demo'].includes(state)) acquireWakeLock();
});
window.addEventListener('pagehide', () => { flushLog(); });

// =====================================================================
// 画面の状態
// =====================================================================

let state = 'idle'; // idle | connecting | connected | reconnecting | error | demo
let screen = 'connect'; // connect | live | actuator | logs | logchart
let mode = 'simple'; // simple | detail | charts | analog（接続したら毎回シンプルから）
let backStack = [];
let lastData = null;
let history = [];
let slots = (store('analogSlots') || 'rpm,coolant').split(',');
if (slots.length !== 2 || !slots.every((s) => DIALS[s])) slots = ['rpm', 'coolant'];

function isLive() { return ['connecting', 'connected', 'reconnecting', 'demo'].includes(state); }

function onData(d, record) {
  lastData = d;
  history.push(d);
  if (history.length > MAX_HISTORY_SIZE) history.shift();
  if (record) logSample(d);
  render();
}

function setState(next, message) {
  const wasLive = isLive();
  state = next;
  const live = isLive();
  if (live && !wasLive) {
    mode = 'simple';
    history = [];
    lastData = null;
    showScreen('live', false);
  }
  if (!live) {
    lastData = null;
    history = [];
    if (screen === 'live' || screen === 'actuator') { backStack = []; showScreen('connect', false); }
  }
  $('connectMsg').hidden = !message;
  $('connectMsg').textContent = message || '';
  $('btnReconnect').hidden = !(next === 'error' && device);
  $('btnConnect').textContent = next === 'error' && device ? '別のアダプターを選ぶ' : 'Bluetoothで接続';
  $('btnStop').textContent = next === 'demo' ? '終了' : '切断';
  updateBar();
  render();
}

function showScreen(name, pushBack = true) {
  if (pushBack && screen !== name) backStack.push(screen);
  screen = name;
  const sections = {
    connect: 'viewConnect', live: 'viewLive', actuator: 'viewActuator', logs: 'viewLogs', logchart: 'viewLogChart',
  };
  const analog = name === 'live' && mode === 'analog';
  for (const [key, id] of Object.entries(sections)) $(id).hidden = key !== name || analog;
  $('viewAnalog').hidden = !analog;
  document.body.classList.toggle('mode-analog', analog);
  $('menu').hidden = true;
  if (name === 'logs') refreshLogList();
  updateBar();
  render();
  window.scrollTo(0, 0);
}
function goBack() {
  let prev = backStack.pop() || 'connect';
  if ((prev === 'live' || prev === 'actuator') && !isLive()) prev = 'connect';
  showScreen(prev, false);
}
function setMode(next) {
  mode = next;
  showScreen('live', false);
}

function updateBar() {
  const title = $('barTitle');
  title.className = 'title';
  if (screen === 'live') {
    const labels = {
      connecting: ['接続中…', 'warn'],
      connected: [KNOWN_ECU_IDS[ecuId] || `MEMS 接続済み(ID: ${ecuId})`, 'ok'],
      reconnecting: ['再接続中…', 'warn'],
      demo: ['デモモード', 'demo'],
    };
    const [text, cls] = labels[state] || ['未接続', ''];
    title.textContent = text;
    title.className = `title badge ${cls}`;
  } else {
    title.textContent = {
      connect: 'ローバーミニ MEMS診断', actuator: '部品テスト', logs: '記録済みログ', logchart: logChartName,
    }[screen];
  }
  $('btnMenu').hidden = screen !== 'live';
  for (const b of $('menu').querySelectorAll('[data-mode]')) b.classList.toggle('active', b.dataset.mode === mode);
  const reconnecting = state === 'reconnecting' || state === 'error';
  $('btnAnalogReconnect').hidden = !reconnecting;
}

// ---------- 夜間モード（時間帯で自動、ボタンでその場だけ切り替え） ----------
let nightOverride = null;
function isAutoNight() {
  const h = new Date().getHours();
  return h >= NIGHT_START_HOUR || h < NIGHT_END_HOUR;
}
function applyNight() {
  const night = nightOverride ?? isAutoNight();
  $('nightOverlay').hidden = !night;
  for (const id of ['btnNight', 'btnNightAnalog']) $(id).textContent = night ? '☀️' : '🌙';
}
function toggleNight() {
  nightOverride = !(nightOverride ?? isAutoNight());
  applyNight();
}

// =====================================================================
// 描画
// =====================================================================

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
  slots.forEach((key, slot) => {
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
function saveSlots() {
  store('analogSlots', slots.join(','));
  setupDials();
  render();
}
// 背景スワイプ: 今表示されていない2つのメーターに丸ごと入れ替える（A面/B面）
function flipDials() {
  slots = DIAL_ORDER.filter((k) => !slots.includes(k)).slice(0, 2);
  saveSlots();
}
// ⋮ボタン: その枠に表示するメーターを選ぶ（もう一方の枠に出ていれば入れ替え）
function pickDial(slot) {
  const box = $('pickOptions');
  box.innerHTML = '';
  for (const key of DIAL_ORDER) {
    const b = document.createElement('button');
    b.textContent = DIALS[key].label;
    if (slots[slot] === key) b.className = 'current';
    b.addEventListener('click', () => {
      const other = 1 - slot;
      if (slots[other] === key) slots[other] = slots[slot];
      slots[slot] = key;
      $('pickDialog').close();
      saveSlots();
    });
    box.appendChild(b);
  }
  $('pickDialog').showModal();
}

function hasFault(d) { return FAULTS.some((f) => d.faults[f.key]); }

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

function fillTable(table, rows) {
  if (table.rows.length !== rows.length) {
    table.innerHTML = '';
    for (let i = 0; i < rows.length; i++) table.insertRow().append(document.createElement('td'), document.createElement('td'));
  }
  rows.forEach(([label, value], i) => {
    const [a, b] = table.rows[i].cells;
    if (a.textContent !== label) a.textContent = label;
    if (typeof value === 'string') {
      if (b.textContent !== value) b.textContent = value;
    } else {
      b.replaceChildren(value);
    }
  });
}
function faultCell(isFaulty) {
  const span = document.createElement('span');
  span.className = 'fault-cell';
  const lamp = document.createElement('i');
  lamp.className = 'fault-lamp' + (isFaulty ? ' on' : '');
  span.append(isFaulty ? 'エラーあり' : '正常', lamp);
  return span;
}

// 折れ線グラフ（LineChart.kt と同じく、最小・中間・最大の目盛り＋必要なら時刻）
function drawLineChart(canvas, values, timeLabels) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const lineColor = css.getPropertyValue('--accent').trim();
  const muted = css.getPropertyValue('--muted').trim();
  const clean = values.filter((v) => v != null && !Number.isNaN(v));
  if (clean.length < 2) return;
  const timeStrip = timeLabels && timeLabels.length ? 20 : 0;
  const plotH = h - timeStrip;
  let min = Infinity;
  let max = -Infinity;
  for (const v of clean) { if (v < min) min = v; if (v > max) max = v; }
  const range = max - min > 0.0001 ? max - min : 1;
  const axisW = 46;
  const chartW = w - axisW;
  const stepX = chartW / (values.length - 1);
  ctx.font = '11px -apple-system, sans-serif';
  ctx.textBaseline = 'middle';
  for (const f of [0, 0.5, 1]) {
    const y = plotH - f * (plotH - 2) - 1;
    ctx.strokeStyle = muted;
    ctx.globalAlpha = 0.3;
    ctx.beginPath(); ctx.moveTo(axisW, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = muted;
    const v = min + f * range;
    ctx.fillText(Number.isInteger(v) ? String(v) : v.toFixed(1), 2, Math.min(Math.max(y, 7), plotH - 6));
  }
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  let started = false;
  values.forEach((v, i) => {
    if (v == null || Number.isNaN(v)) return;
    const x = axisW + i * stepX;
    const y = plotH - ((v - min) / range) * (plotH - 2) - 1;
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  });
  ctx.stroke();
  if (timeStrip) {
    ctx.fillStyle = muted;
    ctx.textAlign = 'center';
    timeLabels.forEach((label, i) => {
      const f = timeLabels.length > 1 ? i / (timeLabels.length - 1) : 0;
      const x = Math.min(Math.max(axisW + f * chartW, axisW + 16), w - 16);
      ctx.fillText(label, x, plotH + timeStrip * 0.6);
    });
    ctx.textAlign = 'left';
  }
}
function makeChartCard(label, withTime) {
  const card = document.createElement('div');
  card.className = 'chart-card';
  const l = document.createElement('div');
  l.className = 'label';
  l.textContent = label;
  const canvas = document.createElement('canvas');
  if (withTime) canvas.className = 'with-time';
  card.append(l, canvas);
  return { card, canvas };
}

let liveChartCanvases = [];
function render() {
  const d = lastData;
  updateActuatorAvailability(d);
  if (screen !== 'live') return;

  if (mode === 'analog') {
    $('analogWaiting').hidden = !!d;
    $('dials').style.visibility = d ? '' : 'hidden';
    if (!d) return;
    slots.forEach((key, slot) => {
      const dial = DIALS[key];
      const el = $(`gauge${slot}`);
      el.querySelector('.needle').style.setProperty('--rot', `${dialAngle(dial, dial.value(d)) - 270}deg`);
      el.querySelector('.digital span').textContent = dial.text(d);
    });
    for (const lamp of $('lamps').children) lamp.classList.toggle('on', d.faults[lamp.dataset.fault]);
    return;
  }

  $('waiting').hidden = !!d;
  $('banner').hidden = !d;
  $('panelSimple').hidden = !d || mode !== 'simple';
  $('panelDetail').hidden = !d || mode !== 'detail';
  $('panelCharts').hidden = !d || mode !== 'charts';
  if (!d) return;
  const bad = hasFault(d);
  $('banner').textContent = bad ? 'センサーエラー・詳細を確認' : 'センサーエラーなし';
  $('banner').className = 'banner' + (bad ? ' ng' : '');

  if (mode === 'simple') {
    for (const el of $('cards').querySelectorAll('.v')) el.textContent = METRICS[el.dataset.metric].fmt(d);
  } else if (mode === 'detail') {
    fillTable($('detailRows'), detailRows(d));
    fillTable($('faultRows'), FAULTS.map((f) => [f.label, faultCell(d.faults[f.key])]));
  } else if (mode === 'charts') {
    $('chartsWaiting').hidden = history.length >= 2;
    $('liveCharts').hidden = history.length < 2;
    if (history.length >= 2) {
      LIVE_CHARTS.forEach((c, i) => drawLineChart(liveChartCanvases[i], history.map(c.value)));
    }
  }
}

function updateRecordingLine() {
  const line = $('recordingLine');
  line.hidden = !logger.cur;
  if (logger.cur) line.textContent = `記録中: ${logger.cur.name}`;
}
let liveMsgTimer = null;
function showLiveMessage(text) {
  $('liveMsg').textContent = text;
  $('liveMsg').hidden = false;
  clearTimeout(liveMsgTimer);
  liveMsgTimer = setTimeout(() => { $('liveMsg').hidden = true; }, 2000);
}

// ---------- 部品テスト ----------
let actResultTimer = null;
function showActuatorResult(text, ok) {
  const el = $('actResult');
  el.textContent = text;
  el.className = 'act-result ' + (ok ? 'ok' : 'ng');
  el.hidden = false;
  clearTimeout(actResultTimer);
  actResultTimer = setTimeout(() => { el.hidden = true; }, 2000);
}
// 安全のため、回転数0（エンジン停止）を確認できた時だけ部品テストを押せる（Android版と同じ）
function updateActuatorAvailability(d) {
  const canTest = d != null && d.rpm === 0;
  const status = $('actStatus');
  status.textContent = canTest ? 'テスト可能' : 'エンジン停止時のみ';
  status.className = 'act-status ' + (canTest ? 'ok' : 'ng');
  for (const b of document.querySelectorAll('.act-btn')) b.disabled = !canTest || b.dataset.unsupported === '1';
}

// ---------- ログ一覧・ログのグラフ ----------
let logChartName = '';
async function refreshLogList() {
  if (logger.cur) await flushLog();
  let logs = [];
  try {
    logs = await listLogs();
  } catch (e) {
    log(`✗ ログ一覧の読み込み失敗: ${e.message}`);
  }
  const list = $('logList');
  list.innerHTML = '';
  $('logsEmpty').hidden = logs.length > 0;
  for (const meta of logs) {
    const item = document.createElement('div');
    item.className = 'log-item';
    const created = new Date(meta.created);
    const dateText = `${created.getFullYear()}/${pad(created.getMonth() + 1)}/${pad(created.getDate())} ${formatClock(created)}`;
    const recording = logger.cur && logger.cur.id === meta.id;
    item.innerHTML = '<div class="name"></div><div class="meta"></div><div class="actions"></div>';
    item.querySelector('.name').textContent = meta.name;
    item.querySelector('.meta').textContent = `${dateText} ・ ${(meta.size / 1024).toFixed(1)} KB${recording ? ' ・ 記録中' : ''}`;
    const actions = item.querySelector('.actions');
    const add = (text, fn, cls) => {
      const b = document.createElement('button');
      b.textContent = text;
      if (cls) b.className = cls;
      b.addEventListener('click', fn);
      actions.append(b);
      return b;
    };
    add('グラフで見る', () => openLogChart(meta));
    add('共有', () => shareLog(meta));
    const del = add('削除', async () => {
      if (!confirm(`${meta.name} を削除しますか？`)) return;
      await deleteLog(meta.id);
      refreshLogList();
    }, 'danger');
    if (recording) del.disabled = true;
    list.append(item);
  }
}

async function shareLog(meta) {
  if (logger.cur && logger.cur.id === meta.id) await flushLog();
  const text = await readLogText(meta.id);
  const file = new File([text], meta.name, { type: 'text/csv' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: meta.name });
      return;
    }
  } catch (e) {
    if (e.name === 'AbortError') return; // 共有画面を閉じただけ
    log(`共有できなかったのでダウンロードに切り替え: ${e.message}`);
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = meta.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// LogFileParser.kt と同じ: 数値の列だけを、時刻つきで取り出す
function parseLogCsv(text) {
  let header = null;
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#')) header = line.slice(1).split(',');
    else if (header && line.trim()) rows.push(line.split(','));
  }
  if (!header) return [];
  const timeIndex = header.indexOf('time');
  // 時刻だけで日付が無いので、深夜0時をまたいだら+24時間して単調増加にする
  let dayOffset = 0;
  let last = -1;
  const stamps = rows.map((row) => {
    const m = /^(\d+):(\d+):(\d+)(?:\.(\d+))?$/.exec(row[timeIndex] || '');
    if (!m) return null;
    const raw = ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +(m[4] || 0);
    if (last >= 0 && raw + dayOffset < last) dayOffset += 86400000;
    last = raw + dayOffset;
    return last;
  });
  const series = [];
  for (const [name, label] of LOG_COLUMNS) {
    const col = header.indexOf(name);
    if (col < 0) continue;
    const values = [];
    const times = [];
    rows.forEach((row, i) => {
      const v = parseFloat(row[col]);
      if (!Number.isNaN(v) && stamps[i] != null) { values.push(v); times.push(stamps[i]); }
    });
    if (values.length) series.push({ label, values, times });
  }
  return series;
}
// 時刻の目盛りは開始・中間2点・終了の4点（LogChartScreen.kt と同じ）
function timeAxisLabels(times) {
  if (times.length < 2) return [];
  return [0, 1, 2, 3].map((i) => {
    const ms = times[Math.floor((i / 3) * (times.length - 1))] % 86400000;
    return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}`;
  });
}
async function openLogChart(meta) {
  logChartName = meta.name;
  showScreen('logchart');
  $('logChartMsg').textContent = '読み込み中…';
  $('logChartMsg').hidden = false;
  $('logCharts').innerHTML = '';
  if (logger.cur && logger.cur.id === meta.id) await flushLog();
  const series = parseLogCsv(await readLogText(meta.id));
  if (!series.length) {
    $('logChartMsg').textContent = 'グラフに表示できるデータがありません';
    return;
  }
  $('logChartMsg').hidden = true;
  const drawn = series.map((s) => {
    const { card, canvas } = makeChartCard(s.label, true);
    $('logCharts').append(card);
    return { s, canvas };
  });
  for (const { s, canvas } of drawn) drawLineChart(canvas, s.values, timeAxisLabels(s.times));
}

// ---------- 時計 ----------
function tickClock() { $('clock').textContent = formatClock(new Date()); }

// =====================================================================
// 画面の部品を組み立てて、ボタンをつなぐ
// =====================================================================

function buildStatic() {
  // シンプル画面のカード
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
    $('cards').appendChild(card);
  }
  // グラフ画面
  liveChartCanvases = LIVE_CHARTS.map((c) => {
    const { card, canvas } = makeChartCard(c.label, false);
    $('liveCharts').append(card);
    return canvas;
  });
  // アナログ画面のエラーランプ
  for (const f of FAULTS) {
    const lamp = document.createElement('span');
    lamp.className = 'lamp';
    lamp.dataset.fault = f.key;
    lamp.title = f.lamp;
    lamp.textContent = f.icon;
    $('lamps').appendChild(lamp);
  }
  // 部品テストの行
  for (const a of ACTUATORS) {
    const row = document.createElement('div');
    row.className = 'act-row';
    const name = document.createElement('div');
    name.className = 'act-name';
    name.textContent = a.label;
    if (a.unsupported) {
      const note = document.createElement('small');
      note.textContent = '電動ファンはECU制御ではありません';
      name.append(note);
    }
    const buttons = document.createElement('div');
    buttons.className = 'act-buttons';
    const addButton = (text, cmd) => {
      const b = document.createElement('button');
      b.className = 'primary act-btn';
      b.textContent = text;
      if (a.unsupported) b.dataset.unsupported = '1';
      b.addEventListener('click', async () => {
        const ok = await queueCommand(cmd, `${a.label} ${text}`);
        showActuatorResult(`${a.label}: ${ok ? '実行しました' : '実行に失敗しました'}`, ok);
      });
      buttons.append(b);
    };
    if (a.off == null) {
      addButton('テスト実行', a.on);
    } else {
      addButton('ON', a.on);
      addButton('OFF', a.off);
    }
    row.append(name, buttons);
    $('actRows').appendChild(row);
  }
}

function wireUi() {
  $('btnConnect').addEventListener('click', chooseDeviceAndConnect);
  $('btnReconnect').addEventListener('click', () => { if (device) runBle(); });
  $('btnDemo').addEventListener('click', startDemo);
  $('btnOpenLogs').addEventListener('click', () => showScreen('logs'));
  $('btnStop').addEventListener('click', () => { log('切断ボタン'); stopAll(); });
  $('btnNight').addEventListener('click', toggleNight);
  $('btnNightAnalog').addEventListener('click', toggleNight);
  $('btnMenu').addEventListener('click', (e) => { e.stopPropagation(); $('menu').hidden = !$('menu').hidden; });
  document.addEventListener('click', (e) => { if (!$('menu').contains(e.target)) $('menu').hidden = true; });
  for (const b of $('menu').querySelectorAll('[data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));
  for (const b of $('menu').querySelectorAll('[data-go]')) b.addEventListener('click', () => showScreen(b.dataset.go));
  for (const b of document.querySelectorAll('[data-back]')) b.addEventListener('click', goBack);
  $('btnAnalogBack').addEventListener('click', () => setMode('simple'));
  $('btnAnalogReconnect').addEventListener('click', reconnectNow);
  for (const b of document.querySelectorAll('.pick')) b.addEventListener('click', () => pickDial(Number(b.dataset.slot)));
  // 木目の背景を左右にスワイプすると、表示中でない2つのメーターに入れ替え
  // （メーター自体は誤タッチで切り替わらないよう対象外。Android版と同じ）
  let swipeStartX = null;
  $('viewAnalog').addEventListener('touchstart', (e) => {
    swipeStartX = e.target.closest('.gauge, button') ? null : e.touches[0].clientX;
  }, { passive: true });
  $('viewAnalog').addEventListener('touchend', (e) => {
    if (swipeStartX == null) return;
    if (Math.abs(e.changedTouches[0].clientX - swipeStartX) >= SWIPE_THRESHOLD_PX) flipDials();
    swipeStartX = null;
  });
  $('btnClearFaults').addEventListener('click', async () => {
    const btn = $('btnClearFaults');
    btn.disabled = true;
    const ok = await queueCommand(CMD.CLEAR_FAULTS, 'エラークリア');
    btn.disabled = false;
    showLiveMessage(ok ? 'エラーコードをクリアしました' : 'クリアに失敗しました');
  });
  $('btnRefreshLogs').addEventListener('click', refreshLogList);
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
  window.addEventListener('resize', () => render());
}

function init() {
  buildStatic();
  setupDials();
  wireUi();
  applyNight();
  setInterval(() => { if (nightOverride == null) applyNight(); }, 60000);
  tickClock();
  setInterval(tickClock, 1000);
  if (!navigator.bluetooth) {
    $('supportNote').innerHTML = '<span class="ng">このブラウザはBluetoothに対応していません。iPhoneでは「Bluefy」、AndroidではChromeで開いてください。デモモードと保存したログはこのままお試しいただけます。</span>';
    $('btnConnect').disabled = true;
  }
  setState('idle');
  log('ページ読み込み');
}

init();
