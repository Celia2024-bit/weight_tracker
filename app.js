/* ── 1. 核心配置与全局状态 ─────────────────────────────────────── */
const STORAGE_KEY = 'keepfit-weight-v2';
const HEIGHT_KEY = 'keepfit-user-height';

// 🔌 后端 API 配置：本地测试用 localhost，发布到 Render 后记得改成你的 Render 域名
// const API_BASE = 'http://localhost:5000/api/weight'; 
const API_BASE = 'https://backend-all-6q0a.onrender.com/api/weight';

const USERNAME = 'default_user'; // 你的专属同步账号名

let entries = [];
let currentHeight = 170; // 默认身高 (cm)
let chartInstance = null;
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

function mealSummary(meals) {
  const parts = [];
  if (meals?.breakfast) parts.push('B: ' + meals.breakfast);
  if (meals?.lunch) parts.push('L: ' + meals.lunch);
  if (meals?.dinner) parts.push('D: ' + meals.dinner);
  return parts.length ? parts.join(' · ') : 'No meals recorded';
}

function normalizeEntry(e) {
  const date = e.date || (e.timestamp ? e.timestamp.slice(0, 10) : todayISO());
  const time = e.time || (e.timestamp ? new Date(e.timestamp).toTimeString().slice(0, 5) : '08:00');
  return {
    id: e.id || crypto.randomUUID(),
    weight: Math.round(parseFloat(e.weight) * 100) / 100,
    date,
    time,
    period: e.period || derivePeriod(time),
    meals: e.meals || { breakfast: '', lunch: '', dinner: '' },
    timestamp: e.timestamp || buildTimestamp(date, time),
  };
}

/* ── 3. 云端同步核心引擎 (Neon DB 数据交互) ────────────────────────── */

async function syncFromCloud() {
  try {
    // 加上 ?username=${USERNAME}
    const res = await fetch(`${API_BASE}/get_weight?username=${USERNAME}`);
    if (res.ok) {
      const cloudData = await res.json();
      if (Array.isArray(cloudData)) {
        entries = cloudData.map(normalizeEntry);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
        renderAll();
        console.log("☁️ Multidevice snapshot fetched from Neon rows.");
        return;
      }
    }
  } catch (err) {
    console.warn("⚠️ Sync deferred. Running in local snapshot fallback mode:", err);
  }
  loadLocalBackup();
}
async function syncSingleEntryToCloud(entry) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  try {
    await fetch(`${API_BASE}/save_weight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: USERNAME,
        record: entry // 👈 完美契合后端的 payload.get('record') 逻辑
      })
    });
    console.log(`🚀 Incremental sync successful for ID: ${entry.id}`);
  } catch (err) {
    console.warn("⚠️ Cached locally, offline update saved.", err);
  }
}

async function syncDeleteToCloud(id) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  try {
    await fetch(`${API_BASE}/delete_weight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id })
    });
    console.log(`🗑️ Erased remote record ID: ${id}`);
  } catch (err) {
    console.warn("⚠️ Delete cached locally.", err);
  }
}
// 【推送】每次数据增删改，先存本地防丢，再异步推送到 Neon 云端
async function persistEntries() {
  // 1. 先安全地写入本地 LocalStorage
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  
  // 2. 异步向 Flask 后端发送全量同步请求
  try {
    const response = await fetch(`${API_BASE}/save_weight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USERNAME, data: entries })
    });
    if (response.ok) {
      console.log("🚀 Data securely pushed and backed up to Neon Cloud.");
    } else {
      console.error("❌ Server rejected sync request.");
    }
  } catch (err) {
    console.warn("⚠️ Cloud sync failed (offline mode). Local data is safe and will sync next time.", err);
  }
}

function loadLocalBackup() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    entries = raw ? JSON.parse(raw).map(normalizeEntry) : [];
  } catch {
    entries = [];
  }
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
            console.log(`📦 Starting batch import for ${newItemsToImport.length} items...`);
            
            // 使用 Promise.all 并发推送，速度极快
            await Promise.all(newItemsToImport.map(item => syncSingleEntryToCloud(item)));
            
            console.log("✅ All imported items have been synced to Neon.");
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
document.getElementById('logForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('formError');
  const ok = document.getElementById('formSuccess');
  err.classList.add('hidden'); ok.classList.add('hidden');

  const rawW = document.getElementById('weight').value;
  const w = Math.round(parseFloat(rawW) * 100) / 100;
  const d = document.getElementById('entryDate').value;
  const t = document.getElementById('entryTime').value;

  if (!rawW.trim() || isNaN(w) || w <= 0) {
    err.textContent = 'Enter a valid positive weight precision score.';
    return err.classList.remove('hidden');
  }

  // 1. 生成并格式化单条标准对象
  const newEntry = normalizeEntry({
    weight: w, date: d, time: t,
    meals: {
      breakfast: document.getElementById('breakfast').value.trim(),
      lunch: document.getElementById('lunch').value.trim(),
      dinner: document.getElementById('dinner').value.trim()
    }
  });

  // 2. 推入本地数组
  entries.push(newEntry);

  // 🔥【在这里调用】只同步当前这一条新增的数据到云端
  await syncSingleEntryToCloud(newEntry);
  
  // 表单重置与视图更新
  document.getElementById('weight').value = '';
  document.getElementById('breakfast').value = '';
  document.getElementById('lunch').value = '';
  document.getElementById('dinner').value = '';
  document.getElementById('entryDate').value = todayISO();
  document.getElementById('entryTime').value = nowTime();

  ok.textContent = 'Entry recorded successfully!';
  ok.classList.remove('hidden');
  setTimeout(() => ok.classList.add('hidden'), 2500);
  renderAll();
});

// 删除条目
window.deleteEntry = async function(id) {
  if (!confirm('Delete entry permanently?')) return;
  
  entries = entries.filter(i => i.id !== id);
  
  // 🔥【在这里调用】通知后端根据这个 ID 执行物理行 DELETE
  await syncDeleteToCloud(id);
  
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
  const weightInput = document.getElementById(`editW_${id}`).value;
  const dateInput = document.getElementById(`editD_${id}`).value;
  const timeInput = document.getElementById(`editT_${id}`).value;
  
  const w = Math.round(parseFloat(weightInput) * 100) / 100;
  if (isNaN(w) || w <= 0) return alert('Please enter a valid weight.');

  let updatedItem = null;

  entries = entries.map(item => {
    if (item.id === id) {
      updatedItem = normalizeEntry({
        id: item.id,
        weight: w,
        date: dateInput,
        time: timeInput,
        meals: {
          breakfast: document.getElementById(`editB_${id}`).value.trim(),
          lunch: document.getElementById(`editL_${id}`).value.trim(),
          dinner: document.getElementById(`editDin_${id}`).value.trim()
        }
      });
      return updatedItem;
    }
    return item;
  });

  // 🔥【在这里调用】编辑保存后，把被修改的这一条单独发送 Upsert 给后端
  if (updatedItem) {
    await syncSingleEntryToCloud(updatedItem);
  }

  window.editingId = null;
  renderAll();
};

/* ── 9. 数据渲染引擎 (Stats / History / Chart) ────────────────── */
function renderStats() {
  if (!entries.length) {
    ['statLatest','statBmi','statAvg','statChange'].forEach(id => document.getElementById(id).textContent = '—');
    document.getElementById('statLatestMeta').textContent = '';
    document.getElementById('statBmiLabel').textContent = '';
    return;
  }
  const sorted = [...entries].sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
  const first = [...entries].sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp))[0];
  const latest = sorted[0];
  const bmi = calcBmi(latest.weight);

  document.getElementById('statLatest').textContent = `${formatWeight(latest.weight)} kg`;
  document.getElementById('statLatestMeta').textContent = `${latest.date} · ${PERIOD_STYLE[latest.period].label}`;
  document.getElementById('statBmi').textContent = bmi.toFixed(1);
  document.getElementById('statBmiLabel').textContent = bmiLabel(bmi);

  const recent = entries.filter(i => new Date(i.timestamp) >= (Date.now() - 7 * 86400000));
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
      return `
        <li class="py-4 bg-slate-50/50 dark:bg-slate-800/30 rounded-xl px-3 my-2 ring-1 ring-slate-200/50 dark:ring-slate-700/30">
          <div class="space-y-3">
            <div class="grid grid-cols-2 gap-2">
              <div>
                <label class="block text-[10px] text-slate-400">Weight (kg)</label>
                <input id="editW_${i.id}" type="number" step="0.01" value="${i.weight}" class="w-full rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-sm font-semibold" />
              </div>
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
            <div class="grid grid-cols-3 gap-2">
              <div>
                <input id="editB_${i.id}" type="text" value="${i.meals?.breakfast || ''}" placeholder="Breakfast" class="w-full rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-xs" />
              </div>
              <div>
                <input id="editL_${i.id}" type="text" value="${i.meals?.lunch || ''}" placeholder="Lunch" class="w-full rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-xs" />
              </div>
              <div>
                <input id="editDin_${i.id}" type="text" value="${i.meals?.dinner || ''}" placeholder="Dinner" class="w-full rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-xs" />
              </div>
            </div>
            <div class="flex justify-end gap-2 text-xs pt-1">
              <button onclick="cancelEdit()" class="px-2.5 py-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-md transition">Cancel</button>
              <button onclick="saveEdit('${i.id}')" class="px-3 py-1 bg-brand-500 text-white font-medium rounded-md hover:bg-brand-600 shadow-sm transition">Save</button>
            </div>
          </div>
        </li>`;
    }

    return `
      <li class="flex items-start justify-between gap-3 py-3 group">
        <div class="flex items-start gap-3 min-w-0">
          <span class="text-lg mt-0.5">${p.emoji}</span>
          <div class="min-w-0">
            <p class="font-semibold text-slate-900 dark:text-white">${formatWeight(i.weight)} kg
              <span class="ml-1 text-xs font-normal text-slate-400">BMI ${calcBmi(i.weight).toFixed(1)}</span>
            </p>
            <p class="text-xs text-slate-400">${i.date} · ${i.time} · ${p.label}</p>
            <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">${mealSummary(i.meals)}</p>
          </div>
        </div>
        <div class="shrink-0 flex items-center gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
          <button onclick="startEdit('${i.id}')" class="rounded-lg px-2 py-1 text-xs text-brand-600 hover:bg-brand-50 dark:hover:bg-brand-900/20 transition">Edit</button>
          <button onclick="deleteEntry('${i.id}')" class="rounded-lg px-2 py-1 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition">Delete</button>
        </div>
      </li>`;
  }).join('');
}

function renderChart() {
  const canvas = document.getElementById('weightChart');
  const empty = document.getElementById('chartEmpty');
  const isDark = document.documentElement.classList.contains('dark');
  const gridColor = isDark ? 'rgba(148,163,184,0.15)' : 'rgba(148,163,184,0.3)';
  const textColor = isDark ? '#94a3b8' : '#64748b';

  const filtered = [...entries].sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp)).filter(i => {
    if (activeRange === 'all') return true;
    return new Date(i.timestamp) >= (Date.now() - parseInt(activeRange) * 86400000);
  });

  if (!filtered.length) {
    canvas.classList.add('hidden'); empty.classList.remove('hidden');
    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
    return;
  }
  canvas.classList.remove('hidden'); empty.classList.add('hidden');

  if (chartInstance) chartInstance.destroy();
  chartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      labels: filtered.map(i => `${i.date.slice(5)} ${i.time}`),
      datasets: [
        { label: 'Morning', data: filtered.map(i => i.period === 'morning' ? i.weight : null), borderColor: '#10b981', spanGaps: true, borderWidth: 2.5, tension: 0.3 },
        { label: 'Evening', data: filtered.map(i => i.period === 'evening' ? i.weight : null), borderColor: '#8b5cf6', spanGaps: true, borderWidth: 2.5, tension: 0.3 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: textColor } } },
      scales: {
        x: { ticks: { color: textColor }, grid: { color: gridColor } },
        y: { ticks: { color: textColor }, grid: { color: gridColor } }
      }
    }
  });
}

/* ── 10. 趋势图筛选控制 ────────────────────────────────── */
document.querySelectorAll('.range-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    activeRange = btn.dataset.range;
    document.querySelectorAll('.range-btn').forEach(b => {
      b.className = `range-btn rounded-lg px-3 py-1 text-xs font-medium transition ${b === btn ? 'bg-brand-500 text-white' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300'}`;
    });
    renderChart();
  });
});

function renderAll() { renderStats(); renderHistory(); renderChart(); }

/* ── 11. 初始化启动入口 ────────────────────────────────── */
initSettings();
document.getElementById('entryDate').value = todayISO();
document.getElementById('entryTime').value = nowTime();

// 执行首次云端全量数据拉取与多端同步
syncFromCloud();