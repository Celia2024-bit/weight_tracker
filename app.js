/* ── 1. 核心配置与全局状态 ─────────────────────────────────────── */
const STORAGE_KEY = 'keepfit-weight-v2';
const HEIGHT_KEY = 'keepfit-user-height';

// 🔌 后端 API 配置：本地测试用 localhost，发布到 Render 后记得改成你的 Render 域名
//const API_ROOT = 'http://localhost:5000/api';
const API_ROOT = 'https://backend-all-6q0a.onrender.com/api';
const WEIGHT_API = `${API_ROOT}/weight`;
const WAIST_API = `${API_ROOT}/waist`;
const USERNAME = 'default_user'; // 你的专属同步账号名

let entries = [];
let currentHeight = 170; // 默认身高 (cm)
let chartInstance = null;
let waistChartInstance = null;
let activeRange = 7;

// 早晚图标与主题配色映射
const PERIOD_STYLE = {
  morning: { color: '#10b981', emoji: '🌅', label: 'Morning' },
  evening: { color: '#8b5cf6', emoji: '🌙', label: 'Evening' },
};

/* ── 2. 辅助工具函数 ───────────────────────────────────── */
function todayISO() { return new Date().toISOString().slice(0, 10); }
function nowTime() {
  const n = new Date();
  return String(n.getHours()).padStart(2, '0') + ':' + String(n.getMinutes()).padStart(2, '0');
}
function derivePeriod(time) {
  return parseInt(time.split(':')[0], 10) < 12 ? 'morning' : 'evening';
}
function buildTimestamp(date, time) { return new Date(date + 'T' + time + ':00').toISOString(); }
function formatWeight(w) { return (Math.round(w * 100) / 100).toFixed(2); }

function parseWeight(value) {
  if (value == null || value === '') return null;
  const parsed = Math.round(parseFloat(value) * 100) / 100;
  return !isNaN(parsed) && parsed > 0 ? parsed : null;
}

function parseWaistSize(value) {
  if (value == null || value === '') return null;
  const parsed = Math.round(parseFloat(value) * 10) / 10;
  return !isNaN(parsed) && parsed > 0 ? parsed : null;
}

function inferEntryType(e) {
  if (e.entryType === 'weight' || e.entryType === 'waist') return e.entryType;
  const waist = parseWaistSize(e.waistSize);
  const weight = parseWeight(e.weight);
  if (waist != null && weight == null) return 'waist';
  return 'weight';
}

function normalizeEntry(e) {
  const date = e.date || (e.timestamp ? e.timestamp.slice(0, 10) : todayISO());
  const time = e.time || (e.timestamp ? new Date(e.timestamp).toTimeString().slice(0, 5) : '08:00');
  const entryType = inferEntryType(e);
  return {
    id: e.id || crypto.randomUUID(),
    entryType,
    weight: entryType === 'weight' ? parseWeight(e.weight) : null,
    date,
    time,
    period: e.period || derivePeriod(time),
    waistSize: entryType === 'waist' ? parseWaistSize(e.waistSize) : null,
    timestamp: e.timestamp || buildTimestamp(date, time),
  };
}

function weightEntries() {
  return entries.filter(i => i.entryType === 'weight' && i.weight != null);
}

function waistEntries() {
  return entries.filter(i => i.entryType === 'waist' && i.waistSize != null);
}

/* ── 3. 云端同步核心引擎 (Neon DB 数据交互) ────────────────────────── */
// Weight API: GET/POST /api/weight/get_weight | save_weight | delete_weight  → weight_logs
// Waist API:  GET/POST /api/waist/get_waist   | save_waist   | delete_waist   → waist_logs

const SYNC_CONFIG = {
  weight: { api: WEIGHT_API, get: 'get_weight', save: 'save_weight', delete: 'delete_weight' },
  waist:  { api: WAIST_API,  get: 'get_waist',  save: 'save_waist',  delete: 'delete_waist' },
};

function syncConfigFor(entry) {
  return SYNC_CONFIG[entry?.entryType === 'waist' ? 'waist' : 'weight'];
}

function saveLocal() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

async function fetchCloudLogs(kind) {
  const cfg = SYNC_CONFIG[kind];
  const res = await fetch(`${cfg.api}/${cfg.get}?username=${USERNAME}`);
  if (!res.ok) throw new Error(`${kind} fetch failed: ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.map(normalizeEntry);
}

async function syncFromCloud() {
  let weightData = [];
  let waistData = [];
  let weightOk = false;
  let waistOk = false;

  try {
    weightData = await fetchCloudLogs('weight');
    weightOk = true;
  } catch (err) {
    console.warn('⚠️ Weight cloud fetch failed:', err);
  }

  try {
    waistData = await fetchCloudLogs('waist');
    waistOk = true;
  } catch (err) {
    console.warn('⚠️ Waist cloud fetch failed:', err);
  }

  if (weightOk || waistOk) {
    const local = readLocalEntries();
    const localWeight = local.filter(i => i.entryType === 'weight');
    const localWaist = local.filter(i => i.entryType === 'waist');

    entries = [
      ...(weightOk ? weightData : localWeight),
      ...(waistOk ? waistData : localWaist),
    ];
    saveLocal();
    renderAll();
    console.log(`☁️ Loaded ${weightOk ? weightData.length : localWeight.length} weight + ${waistOk ? waistData.length : localWaist.length} waist rows.`);
    return;
  }

  console.warn('⚠️ Cloud unavailable. Using local backup.');
  loadLocalBackup();
}

async function syncSingleEntryToCloud(entry) {
  saveLocal();
  const cfg = syncConfigFor(entry);
  try {
    const res = await fetch(`${cfg.api}/${cfg.save}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USERNAME, record: entry }),
    });
    if (!res.ok) throw new Error(`${entry.entryType} save failed: ${res.status}`);
    console.log(`🚀 Saved ${entry.entryType} to Neon: ${entry.id}`);
  } catch (err) {
    console.warn(`⚠️ ${entry.entryType} saved locally only (offline):`, err);
  }
}

async function syncDeleteToCloud(entry) {
  saveLocal();
  const cfg = syncConfigFor(entry);
  try {
    const res = await fetch(`${cfg.api}/${cfg.delete}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: entry.id }),
    });
    if (!res.ok) throw new Error(`${entry.entryType} delete failed: ${res.status}`);
    console.log(`🗑️ Deleted ${entry.entryType} from Neon: ${entry.id}`);
  } catch (err) {
    console.warn(`⚠️ ${entry.entryType} delete saved locally only (offline):`, err);
  }
}

async function syncAllEntriesToCloud() {
  saveLocal();
  const items = [...weightEntries(), ...waistEntries()];
  if (!items.length) return;
  await Promise.all(items.map((item) => syncSingleEntryToCloud(item)));
  console.log(`🚀 Pushed ${items.length} entries to Neon (${weightEntries().length} weight, ${waistEntries().length} waist).`);
}

function readLocalEntries() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw).map(normalizeEntry) : [];
  } catch {
    return [];
  }
}

function loadLocalBackup() {
  entries = readLocalEntries();
  renderAll();
}

/* ── 4. 基础配置加载 (身高与主题) ────────────────────────────────── */
function initSettings() {
  // 加载身高
  const savedHeight = localStorage.getItem(HEIGHT_KEY);
  currentHeight = savedHeight ? parseFloat(savedHeight) : 170;
  document.getElementById('userHeight').value = currentHeight;

  // 加载黑夜模式主题
  const savedTheme = localStorage.getItem('keepfit-theme');
  if (savedTheme === 'dark' || (!savedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
  }
}

// 动态监听并保存身高
document.getElementById('userHeight').addEventListener('input', (e) => {
  const val = parseFloat(e.target.value);
  if (!isNaN(val) && val > 0) {
    currentHeight = val;
    localStorage.setItem(HEIGHT_KEY, val);
    renderStats();
    renderHistory();
  }
});

// 主题切换
document.getElementById('themeToggle').addEventListener('click', () => {
  document.documentElement.classList.toggle('dark');
  localStorage.setItem('keepfit-theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  renderChart();
  renderWaistChart();
});

/* ── 5. 本地磁盘备份导入/导出 ──────────────────────────────────── */
document.getElementById('btnExport').addEventListener('click', () => {
  if (entries.length === 0) return alert('No data to export!');
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(entries, null, 2));
  const dl = document.createElement('a');
  dl.setAttribute("href", dataStr);
  dl.setAttribute("download", `weight_backup_${todayISO()}.json`);
  document.body.appendChild(dl);
  dl.click();
  dl.remove();
});

document.getElementById('btnImport').addEventListener('click', () => document.getElementById('fileImportSelector').click());
document.getElementById('fileImportSelector').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async function(evt) {
    try {
      const parsed = JSON.parse(evt.target.result);
      if (Array.isArray(parsed)) {
        if (confirm(`Import ${parsed.length} items? This will merge and sync to cloud.`)) {
          const ids = new Set(entries.map(i => i.id));
          
          // 收集所有真正需要新导入的条目
          const newItemsToImport = [];

          parsed.forEach(item => {
            const norm = normalizeEntry(item);
            if (!ids.has(norm.id)) {
              entries.push(norm);
              newItemsToImport.push(norm); // 记录下这张新面孔
            }
          });

          // 🔥【核心修正】如果有新数据，并排同时发送请求，一条龙导入数据库
          if (newItemsToImport.length > 0) {
            saveLocal();
            console.log(`📦 Importing ${newItemsToImport.length} items to Neon...`);
            await Promise.all(newItemsToImport.map((item) => syncSingleEntryToCloud(item)));
            console.log('✅ Imported items synced (weight → weight_logs, waist → waist_logs).');
          }

          renderAll();
        }
      }
    } catch (err) { 
      alert('Invalid file layout structure.'); 
      console.error(err);
    }
  };
  reader.readAsText(file);
});

/* ── 6. 核心健康计算 (BMI) ────────────────────────────────── */
function calcBmi(w) {
  const hm = currentHeight / 100;
  return w / (hm * hm);
}
function bmiLabel(bmi) {
  if (bmi < 18.5) return 'Underweight';
  if (bmi < 25) return 'Normal';
  if (bmi < 30) return 'Overweight';
  return 'Obese';
}

/* ── 7. 数据表单提交操作（新增记录） ───────────────────────────── */
function showFormMessage(errEl, okEl, errorText) {
  errEl.classList.add('hidden');
  okEl.classList.add('hidden');
  if (errorText) {
    errEl.textContent = errorText;
    errEl.classList.remove('hidden');
    return false;
  }
  return true;
}

function flashSuccess(okEl, message) {
  okEl.textContent = message;
  okEl.classList.remove('hidden');
  setTimeout(() => okEl.classList.add('hidden'), 2500);
}

document.getElementById('logWeightForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('weightFormError');
  const ok = document.getElementById('weightFormSuccess');
  const rawW = document.getElementById('weight').value;
  const w = parseWeight(rawW);
  const d = document.getElementById('weightDate').value;
  const t = document.getElementById('weightTime').value;

  if (!showFormMessage(err, ok, !rawW.trim() || w == null ? 'Enter a valid positive weight.' : '')) return;

  const newEntry = normalizeEntry({ entryType: 'weight', weight: w, date: d, time: t });
  entries.push(newEntry);
  saveLocal();
  await syncSingleEntryToCloud(newEntry);

  document.getElementById('weight').value = '';
  document.getElementById('weightDate').value = todayISO();
  document.getElementById('weightTime').value = nowTime();
  flashSuccess(ok, 'Weight recorded successfully!');
  renderAll();
});

document.getElementById('logWaistForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('waistFormError');
  const ok = document.getElementById('waistFormSuccess');
  const rawWaist = document.getElementById('waistSize').value;
  const waist = parseWaistSize(rawWaist);
  const d = document.getElementById('waistDate').value;
  const t = document.getElementById('waistTime').value;

  if (!showFormMessage(err, ok, !rawWaist.trim() || waist == null ? 'Enter a valid positive waist size.' : '')) return;

  const newEntry = normalizeEntry({ entryType: 'waist', waistSize: waist, date: d, time: t });
  entries.push(newEntry);
  saveLocal();
  await syncSingleEntryToCloud(newEntry);

  document.getElementById('waistSize').value = '';
  document.getElementById('waistDate').value = todayISO();
  document.getElementById('waistTime').value = nowTime();
  flashSuccess(ok, 'Waist size recorded successfully!');
  renderAll();
});

// 删除条目
window.deleteEntry = async function(id) {
  if (!confirm('Delete entry permanently?')) return;

  const removed = entries.find(i => i.id === id);
  entries = entries.filter(i => i.id !== id);
  saveLocal();

  if (removed) await syncDeleteToCloud(removed);

  renderAll();
};

/* ── 8. 行内原地编辑控制器 ────────────────────────────────── */
window.startEdit = function(id) {
  window.editingId = id;
  renderHistory(); 
};

window.cancelEdit = function() {
  window.editingId = null;
  renderHistory();
};

window.saveEdit = async function(id) {
  const item = entries.find(i => i.id === id);
  if (!item) return;

  const dateInput = document.getElementById(`editD_${id}`).value;
  const timeInput = document.getElementById(`editT_${id}`).value;
  let updatedItem = null;

  if (item.entryType === 'waist') {
    const waist = parseWaistSize(document.getElementById(`editWaist_${id}`).value);
    if (waist == null) return alert('Please enter a valid waist size.');
    updatedItem = normalizeEntry({
      id: item.id,
      entryType: 'waist',
      waistSize: waist,
      date: dateInput,
      time: timeInput,
    });
  } else {
    const w = parseWeight(document.getElementById(`editW_${id}`).value);
    if (w == null) return alert('Please enter a valid weight.');
    updatedItem = normalizeEntry({
      id: item.id,
      entryType: 'weight',
      weight: w,
      date: dateInput,
      time: timeInput,
    });
  }

  entries = entries.map(entry => entry.id === id ? updatedItem : entry);
  saveLocal();

  if (updatedItem) await syncSingleEntryToCloud(updatedItem);

  window.editingId = null;
  renderAll();
};

/* ── 9. 数据渲染引擎 (Stats / History / Chart) ────────────────── */
function renderStats() {
  const weights = weightEntries();
  if (!weights.length) {
    ['statLatest','statBmi','statAvg','statChange'].forEach(id => document.getElementById(id).textContent = '—');
    document.getElementById('statLatestMeta').textContent = '';
    document.getElementById('statBmiLabel').textContent = '';
    return;
  }
  const sorted = [...weights].sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
  const first = [...weights].sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp))[0];
  const latest = sorted[0];
  const bmi = calcBmi(latest.weight);

  document.getElementById('statLatest').textContent = `${formatWeight(latest.weight)} kg`;
  document.getElementById('statLatestMeta').textContent = `${latest.date} · ${PERIOD_STYLE[latest.period].label}`;
  document.getElementById('statBmi').textContent = bmi.toFixed(1);
  document.getElementById('statBmiLabel').textContent = bmiLabel(bmi);

  const recent = weights.filter(i => new Date(i.timestamp) >= (Date.now() - 7 * 86400000));
  const avg = recent.length ? recent.reduce((s,i) => s + i.weight, 0) / recent.length : latest.weight;
  document.getElementById('statAvg').textContent = `${formatWeight(avg)} kg`;

  const delta = latest.weight - first.weight;
  const el = document.getElementById('statChange');
  el.textContent = `${delta > 0 ? '+' : ''}${formatWeight(delta)} kg`;
  el.className = `mt-1 text-2xl font-bold ${delta < 0 ? 'text-brand-600' : delta > 0 ? 'text-red-500' : ''}`;
}

function renderHistory() {
  const list = document.getElementById('historyList');
  const empty = document.getElementById('historyEmpty');
  if (!entries.length) { list.innerHTML = ''; return empty.classList.remove('hidden'); }
  empty.classList.add('hidden');

  list.innerHTML = [...entries].sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp)).map(i => {
    const p = PERIOD_STYLE[i.period];
    
    if (window.editingId === i.id) {
      const valueField = i.entryType === 'waist'
        ? `<div>
            <label class="block text-[10px] text-slate-400">Waist size (cm)</label>
            <input id="editWaist_${i.id}" type="number" step="0.1" min="0" value="${i.waistSize ?? ''}" class="w-full rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-sm font-semibold" />
          </div>`
        : `<div>
            <label class="block text-[10px] text-slate-400">Weight (kg)</label>
            <input id="editW_${i.id}" type="number" step="0.01" value="${i.weight ?? ''}" class="w-full rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-sm font-semibold" />
          </div>`;

      return `
        <li class="py-4 bg-slate-50/50 dark:bg-slate-800/30 rounded-xl px-3 my-2 ring-1 ring-slate-200/50 dark:ring-slate-700/30">
          <div class="space-y-3">
            <div class="grid grid-cols-2 gap-2">
              ${valueField}
              <div class="grid grid-cols-2 gap-1">
                <div>
                  <label class="block text-[10px] text-slate-400">Date</label>
                  <input id="editD_${i.id}" type="date" value="${i.date}" class="w-full rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-1 py-1 text-xs" />
                </div>
                <div>
                  <label class="block text-[10px] text-slate-400">Time</label>
                  <input id="editT_${i.id}" type="time" value="${i.time}" class="w-full rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-1 py-1 text-xs" />
                </div>
              </div>
            </div>
            <div class="flex justify-end gap-2 text-xs pt-1">
              <button onclick="cancelEdit()" class="px-2.5 py-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-md transition">Cancel</button>
              <button onclick="saveEdit('${i.id}')" class="px-3 py-1 bg-brand-500 text-white font-medium rounded-md hover:bg-brand-600 shadow-sm transition">Save</button>
            </div>
          </div>
        </li>`;
    }

    const isWaist = i.entryType === 'waist';
    const emoji = isWaist ? '📏' : p.emoji;
    const title = isWaist
      ? `${formatWeight(i.waistSize)} cm <span class="ml-1 text-xs font-normal text-violet-500">Waist</span>`
      : `${formatWeight(i.weight)} kg <span class="ml-1 text-xs font-normal text-slate-400">BMI ${calcBmi(i.weight).toFixed(1)}</span>`;

    return `
      <li class="flex items-start justify-between gap-3 py-3 group">
        <div class="flex items-start gap-3 min-w-0">
          <span class="text-lg mt-0.5">${emoji}</span>
          <div class="min-w-0">
            <p class="font-semibold text-slate-900 dark:text-white">${title}</p>
            <p class="text-xs text-slate-400">${i.date} · ${i.time} · ${p.label}</p>
          </div>
        </div>
        <div class="shrink-0 flex items-center gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
          <button onclick="startEdit('${i.id}')" class="rounded-lg px-2 py-1 text-xs text-brand-600 hover:bg-brand-50 dark:hover:bg-brand-900/20 transition">Edit</button>
          <button onclick="deleteEntry('${i.id}')" class="rounded-lg px-2 py-1 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition">Delete</button>
        </div>
      </li>`;
  }).join('');
}

function filterByRange(items) {
  return items.filter(i => {
    if (activeRange === 'all') return true;
    return new Date(i.timestamp) >= (Date.now() - parseInt(activeRange) * 86400000);
  });
}

function chartTheme() {
  const isDark = document.documentElement.classList.contains('dark');
  return {
    gridColor: isDark ? 'rgba(148,163,184,0.15)' : 'rgba(148,163,184,0.3)',
    textColor: isDark ? '#94a3b8' : '#64748b',
  };
}

function buildLineChart(canvas, instance, labels, datasets, emptyEl) {
  const { gridColor, textColor } = chartTheme();

  if (!labels.length) {
    canvas.classList.add('hidden');
    emptyEl.classList.remove('hidden');
    if (instance.current) { instance.current.destroy(); instance.current = null; }
    return null;
  }
  canvas.classList.remove('hidden');
  emptyEl.classList.add('hidden');

  if (instance.current) instance.current.destroy();
  instance.current = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: textColor } } },
      scales: {
        x: { ticks: { color: textColor }, grid: { color: gridColor } },
        y: { ticks: { color: textColor }, grid: { color: gridColor } }
      }
    }
  });
  return instance.current;
}

function renderChart() {
  const sorted = [...weightEntries()].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const filtered = filterByRange(sorted);
  const labels = filtered.map(i => `${i.date.slice(5)} ${i.time}`);
  const datasets = [
    { label: 'Morning', data: filtered.map(i => i.period === 'morning' ? i.weight : null), borderColor: '#10b981', spanGaps: true, borderWidth: 2.5, tension: 0.3 },
    { label: 'Evening', data: filtered.map(i => i.period === 'evening' ? i.weight : null), borderColor: '#8b5cf6', spanGaps: true, borderWidth: 2.5, tension: 0.3 }
  ];
  chartInstance = buildLineChart(
    document.getElementById('weightChart'),
    { current: chartInstance },
    labels,
    datasets,
    document.getElementById('chartEmpty')
  );
}

function renderWaistChart() {
  const sorted = [...waistEntries()].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const filtered = filterByRange(sorted);
  const labels = filtered.map(i => `${i.date.slice(5)} ${i.time}`);
  const datasets = [
    { label: 'Morning', data: filtered.map(i => i.period === 'morning' ? i.waistSize : null), borderColor: '#10b981', spanGaps: true, borderWidth: 2.5, tension: 0.3 },
    { label: 'Evening', data: filtered.map(i => i.period === 'evening' ? i.waistSize : null), borderColor: '#8b5cf6', spanGaps: true, borderWidth: 2.5, tension: 0.3 }
  ];
  waistChartInstance = buildLineChart(
    document.getElementById('waistChart'),
    { current: waistChartInstance },
    labels,
    datasets,
    document.getElementById('waistChartEmpty')
  );
}

/* ── 10. 趋势图筛选控制 ────────────────────────────────── */
function updateRangeButtons() {
  document.querySelectorAll('.range-btn').forEach(b => {
    const selected = b.dataset.range === String(activeRange);
    b.className = `range-btn rounded-lg px-3 py-1 text-xs font-medium transition ${selected ? 'bg-brand-500 text-white' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300'}`;
  });
}

document.querySelectorAll('.range-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    activeRange = btn.dataset.range;
    updateRangeButtons();
    renderChart();
    renderWaistChart();
  });
});

function renderAll() { renderStats(); renderHistory(); renderChart(); renderWaistChart(); }

/* ── 11. 初始化启动入口 ────────────────────────────────── */
initSettings();
document.getElementById('weightDate').value = todayISO();
document.getElementById('weightTime').value = nowTime();
document.getElementById('waistDate').value = todayISO();
document.getElementById('waistTime').value = nowTime();

// 启动：先从 Neon 拉取 weight_logs + waist_logs，再渲染界面
syncFromCloud();