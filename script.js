// ==========================================
// 1. KONFIGURASI & CLIENT ID GOOGLE
// ==========================================
const GOOGLE_CLIENT_ID = "344856021698-6137n8cifj18d1v1kknhgusbs3tn08v2.apps.googleusercontent.com";
const PLN_RATE_PER_KWH = 1444.70; // Tarif PLN per kWh (Golongan R1 1.300 VA)

function getDefaultDevices(email) {
  const prefix = email ? email.split('@')[0] : 'User';
  return [
    { id: Date.now(), name: `Socket ${prefix} #1`, chip: "ESP32-C3 #01", watt: 50, state: false, clicks: 0, uptimeSeconds: 0, schedules: [] }
  ];
}

// Data Sesi Pengguna
let currentUser = JSON.parse(localStorage.getItem('ss_current_user')) || null;
let users = JSON.parse(localStorage.getItem('ss_users')) || [];

// Variabel Data Per-User
let devices = [];
let activeDeviceId = null;
let logsData = [];
let chartHistoryLabels = ['10:00', '10:05', '10:10', '10:15', '10:20', '10:25'];
let chartHistoryData = [0, 0, 0, 0, 0, 0];

let currentMetricPeriod = 'daily'; // 'daily', 'monthly', 'total'
let timerInterval = null;
let energyInterval = null;
let scheduleCheckInterval = null;
let ws = null;
let isRegisterMode = false;

// ==========================================
// 2. INISIALISASI CHART, NOTIFIKASI & GOOGLE OAUTH
// ==========================================
const ctx = document.getElementById('usageChart').getContext('2d');
const usageChart = new Chart(ctx, {
  type: 'line',
  data: {
    labels: chartHistoryLabels,
    datasets: [{
      label: 'Status Sakelar',
      data: chartHistoryData,
      borderColor: '#3b82f6',
      backgroundColor: 'rgba(59, 130, 246, 0.1)',
      fill: true,
      tension: 0.3
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: { y: { min: 0, max: 1, ticks: { stepSize: 1 } }, x: { grid: { display: false } } }
  }
});

window.onload = function () {
  checkAuth();
  requestNotificationPermission();

  if (window.google) {
    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: handleGoogleCallback
    });

    google.accounts.id.renderButton(
      document.getElementById("google-btn-container"),
      { theme: "outline", size: "large", text: "continue_with", shape: "pill" }
    );
  }

  initWebSocket();
  startEnergyTracker();
  
  // Pengecekan jadwal otomatis setiap 5 detik
  if (scheduleCheckInterval) clearInterval(scheduleCheckInterval);
  scheduleCheckInterval = setInterval(checkScheduleRules, 5000);
};

// ==========================================
// 3. SISTEM NOTIFIKASI (LAPTOP & TOAST WEB)
// ==========================================
function requestNotificationPermission() {
  if ("Notification" in window) {
    if (Notification.permission !== "granted" && Notification.permission !== "denied") {
      Notification.requestPermission();
    }
  }
}

function sendDesktopNotification(title, body) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, {
      body: body,
      icon: "https://cdn-icons-png.flaticon.com/512/2983/2983780.png"
    });
  }
  showToast(body, title.includes("ON") || title.includes("Dinyalakan") ? "success" : "info");
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  let iconClass = 'fa-circle-info';
  if (type === 'success') iconClass = 'fa-circle-check';
  else if (type === 'danger') iconClass = 'fa-circle-xmark';
  else if (type === 'warning') iconClass = 'fa-triangle-exclamation';

  toast.innerHTML = `
    <i class="fa-solid ${iconClass} toast-icon"></i>
    <span>${message}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 4000);
}

// ==========================================
// 4. ISOLASI DATA TERPISAH PER EMAIL
// ==========================================
function loadUserData(userObj) {
  if (!userObj || !userObj.email) return;

  const safeEmail = userObj.email.replace(/[^a-zA-Z0-9]/g, "_");
  const userKey = `ss_data_${safeEmail}`;
  const savedDataStr = localStorage.getItem(userKey);

  if (savedDataStr) {
    const parsedData = JSON.parse(savedDataStr);
    devices = parsedData.devices || getDefaultDevices(userObj.email);
    activeDeviceId = parsedData.activeDeviceId || devices[0]?.id;
    logsData = parsedData.logsData || [];
    chartHistoryLabels = parsedData.chartHistoryLabels || ['10:00', '10:05', '10:10', '10:15', '10:20', '10:25'];
    chartHistoryData = parsedData.chartHistoryData || [0, 0, 0, 0, 0, 0];
  } else {
    devices = getDefaultDevices(userObj.email);
    activeDeviceId = devices[0].id;
    logsData = [{ time: new Date().toLocaleTimeString('id-ID'), message: `Akun baru dibuat untuk ${userObj.email}`, type: 'info' }];
    chartHistoryLabels = ['10:00', '10:05', '10:10', '10:15', '10:20', '10:25'];
    chartHistoryData = [0, 0, 0, 0, 0, 0];
  }

  usageChart.data.labels = chartHistoryLabels;
  usageChart.data.datasets[0].data = chartHistoryData;
  usageChart.update();

  saveData();
  renderDeviceTabs();
  renderLogs();
  updateEnergyUI();
}

function saveData() {
  if (!currentUser || !currentUser.email) return;

  const safeEmail = currentUser.email.replace(/[^a-zA-Z0-9]/g, "_");
  const userKey = `ss_data_${safeEmail}`;

  const dataToSave = {
    devices,
    activeDeviceId,
    logsData,
    chartHistoryLabels,
    chartHistoryData
  };

  localStorage.setItem(userKey, JSON.stringify(dataToSave));
}

// ==========================================
// 5. LOGIKA ANALYTICS & BIAYA LISTRIK PLN
// ==========================================
function changeMetricPeriod(period) {
  currentMetricPeriod = period;
  const labelElem = document.getElementById('period-label');
  if (labelElem) {
    if (period === 'daily') labelElem.innerText = 'Hari Ini';
    else if (period === 'monthly') labelElem.innerText = 'Bulan Ini';
    else labelElem.innerText = 'Total';
  }
  updateEnergyUI();
}

function checkAutoReset(dev) {
  const now = new Date();
  const todayStr = now.toDateString();
  const monthStr = `${now.getFullYear()}-${now.getMonth()}`;

  if (!dev.metrics) {
    dev.metrics = {
      lastDate: todayStr,
      lastMonth: monthStr,
      dailySeconds: 0,
      monthlySeconds: 0,
      totalSeconds: dev.uptimeSeconds || 0
    };
  }

  if (dev.metrics.lastDate !== todayStr) {
    dev.metrics.dailySeconds = 0;
    dev.metrics.lastDate = todayStr;
  }

  if (dev.metrics.lastMonth !== monthStr) {
    dev.metrics.monthlySeconds = 0;
    dev.metrics.lastMonth = monthStr;
  }
}

function startEnergyTracker() {
  if (energyInterval) clearInterval(energyInterval);
  
  energyInterval = setInterval(() => {
    let stateChanged = false;

    devices.forEach(dev => {
      checkAutoReset(dev);

      if (dev.state) {
        dev.metrics.dailySeconds++;
        dev.metrics.monthlySeconds++;
        dev.metrics.totalSeconds++;
        dev.uptimeSeconds = dev.metrics.totalSeconds;
        stateChanged = true;
      }
    });

    if (stateChanged) {
      saveData();
      updateEnergyUI();
    }
  }, 1000);
}

function updateEnergyUI() {
  const current = devices.find(d => d.id === activeDeviceId);
  if (!current) return;

  checkAutoReset(current);

  let activeSec = 0;
  if (currentMetricPeriod === 'daily') activeSec = current.metrics.dailySeconds;
  else if (currentMetricPeriod === 'monthly') activeSec = current.metrics.monthlySeconds;
  else activeSec = current.metrics.totalSeconds;

  const hours = Math.floor(activeSec / 3600);
  const minutes = Math.floor((activeSec % 3600) / 60);
  const seconds = activeSec % 60;
  const formattedUptime = `${String(hours).padStart(2, '0')}j ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;

  const watt = current.watt || 50;
  const totalHours = activeSec / 3600;
  const kWh = (watt * totalHours) / 1000;
  const costRp = kWh * PLN_RATE_PER_KWH;

  const dailyKwhEst = (watt * 24) / 1000;
  const dailyCostEst = dailyKwhEst * PLN_RATE_PER_KWH;
  const monthlyCostEst = dailyCostEst * 30;

  const uptimeElem = document.getElementById('uptime-text');
  const wattElem = document.getElementById('device-watt-text');
  const kwhElem = document.getElementById('total-kwh-text');
  const costElem = document.getElementById('total-cost-text');
  const dailyEstElem = document.getElementById('daily-cost-est');
  const monthlyEstElem = document.getElementById('monthly-cost-est');

  if (uptimeElem) uptimeElem.innerText = formattedUptime;
  if (wattElem) wattElem.innerText = `${watt} Watt`;
  if (kwhElem) kwhElem.innerText = `${kWh.toFixed(4)} kWh`;
  if (costElem) costElem.innerText = `Rp ${Math.round(costRp).toLocaleString('id-ID')}`;
  if (dailyEstElem) dailyEstElem.innerText = `Rp ${Math.round(dailyCostEst).toLocaleString('id-ID')} / hari`;
  if (monthlyEstElem) monthlyEstElem.innerText = `Rp ${Math.round(monthlyCostEst).toLocaleString('id-ID')} / bulan`;
}

// ==========================================
// 6. AUTENTIKASI LOGIN / LOGOUT
// ==========================================
function checkAuth() {
  if (currentUser) {
    document.getElementById('auth-modal').classList.add('hidden');
    document.getElementById('user-display-name').innerText = currentUser.name || currentUser.email;
    loadUserData(currentUser);
  } else {
    document.getElementById('auth-modal').classList.remove('hidden');
  }
}

async function handleGoogleCallback(response) {
  try {
    const res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: response.credential })
    });

    const data = await res.json();
    if (data.success) {
      currentUser = data.user;
      
      // Daftarkan ke akun lokal users jika belum ada
      let usersList = JSON.parse(localStorage.getItem('ss_users')) || [];
      const existingUser = usersList.find(u => u.email === currentUser.email);
      if (!existingUser) {
        usersList.push({
          name: currentUser.name || currentUser.email.split('@')[0],
          email: currentUser.email,
          password: ''
        });
        localStorage.setItem('ss_users', JSON.stringify(usersList));
      }

      localStorage.setItem('ss_current_user', JSON.stringify(currentUser));
      
      loadUserData(currentUser);
      document.getElementById('auth-modal').classList.add('hidden');
      document.getElementById('user-display-name').innerText = currentUser.name || currentUser.email;
      
      addLog(`Berhasil masuk via Google: ${currentUser.email}`, 'info');
      sendDesktopNotification("Login Berhasil", `Selamat datang kembali, ${currentUser.name || currentUser.email}`);
    } else {
      alert('Gagal verifikasi token Google!');
    }
  } catch (err) {
    console.error("Auth error:", err);
    alert('Gagal terhubung ke server autentikasi!');
  }
}

function toggleAuthMode(e) {
  e.preventDefault();
  isRegisterMode = !isRegisterMode;

  const title = document.getElementById('auth-title');
  const btn = document.getElementById('auth-submit-btn');
  const usernameGroup = document.getElementById('username-group');
  const toggleText = document.getElementById('toggle-text');
  const toggleLink = document.getElementById('toggle-link');

  if (isRegisterMode) {
    title.innerText = 'Daftar Akun Baru';
    btn.innerText = 'Daftar Sekarang';
    usernameGroup.classList.remove('hidden');
    toggleText.innerText = 'Sudah punya akun?';
    toggleLink.innerText = 'Masuk di sini';
  } else {
    title.innerText = 'Masuk ke Akun';
    btn.innerText = 'Masuk';
    usernameGroup.classList.add('hidden');
    toggleText.innerText = 'Belum punya akun?';
    toggleLink.innerText = 'Daftar Sekarang';
  }
}

function handleAuth(e) {
  e.preventDefault();
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value.trim();
  const username = document.getElementById('auth-username').value.trim();
  const errorMsg = document.getElementById('auth-error');

  errorMsg.style.display = 'none';

  let usersList = JSON.parse(localStorage.getItem('ss_users')) || [];

  if (isRegisterMode) {
    const existing = usersList.find(u => u.email === email);
    if (existing) {
      errorMsg.innerText = 'Email sudah terdaftar!';
      errorMsg.style.display = 'block';
      return;
    }

    const newUser = { name: username || email.split('@')[0], email, password };
    usersList.push(newUser);
    localStorage.setItem('ss_users', JSON.stringify(usersList));

    currentUser = newUser;
    localStorage.setItem('ss_current_user', JSON.stringify(currentUser));
    checkAuth();
  } else {
    let user = usersList.find(u => u.email === email && u.password === password);

    // Otomatis sinkronisasi password baru jika akun Google lokal pernah dipakai
    const safeEmail = email.replace(/[^a-zA-Z0-9]/g, "_");
    const hasGoogleData = localStorage.getItem(`ss_data_${safeEmail}`);

    if (!user && hasGoogleData) {
      const newUser = { name: email.split('@')[0], email, password };
      usersList.push(newUser);
      localStorage.setItem('ss_users', JSON.stringify(usersList));
      user = newUser;
    }

    if (user) {
      currentUser = user;
      localStorage.setItem('ss_current_user', JSON.stringify(currentUser));
      checkAuth();
    } else {
      errorMsg.innerText = 'Email atau kata sandi salah!';
      errorMsg.style.display = 'block';
    }
  }
}

function handleLogout() {
  currentUser = null;
  localStorage.removeItem('ss_current_user');
  checkAuth();
}

// ==========================================
// 7. WEBSOCKET REAL-TIME
// ==========================================
function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}`);

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'STATE_UPDATE') {
      updateSystemState(data.state, data.online);
    }
  };

  ws.onclose = () => {
    setTimeout(initWebSocket, 2000);
  };
}

function updateSystemState(state, isOnline) {
  const current = devices.find(d => d.id === activeDeviceId);

  if (isOnline && current) {
    current.state = state;
  }

  const statusBadge = document.getElementById('connection-status');
  const statusText = document.getElementById('status-text');

  if (statusBadge && statusText) {
    if (isOnline) {
      statusBadge.className = 'status-badge online';
      statusText.innerText = 'Online';
    } else {
      statusBadge.className = 'status-badge offline';
      statusText.innerText = 'Hardware Offline';
    }
  }

  updateActiveDeviceUI();
}

// ==========================================
// 8. KONTROL DEVICE & SAKELAR
// ==========================================
function togglePower() {
  const current = devices.find(d => d.id === activeDeviceId);
  if (!current) return;

  current.state = !current.state;
  current.clicks = (current.clicks || 0) + 1;

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'TOGGLE_RELAY', state: current.state }));
  }

  saveData();

  if (current.state) {
    addLog(`Aksi [${current.name}]: Dinyalakan (ON)`, 'on');
    sendDesktopNotification("SmartSocket ON", `Perangkat [${current.name}] telah dinyalakan.`);
    updateChart(1);
  } else {
    addLog(`Aksi [${current.name}]: Dimatikan (OFF)`, 'off');
    sendDesktopNotification("SmartSocket OFF", `Perangkat [${current.name}] telah dimatikan.`);
    updateChart(0);
  }

  updateActiveDeviceUI();
}

function renderDeviceTabs() {
  const tabsContainer = document.getElementById('device-tabs');
  if (!tabsContainer) return;

  tabsContainer.innerHTML = '';

  devices.forEach(dev => {
    const tab = document.createElement('div');
    tab.className = `device-tab ${dev.id === activeDeviceId ? 'active' : ''}`;

    tab.innerHTML = `
      <span onclick="switchDevice(${dev.id})"><i class="fa-solid fa-plug"></i> ${dev.name}</span>
      <i class="fa-solid fa-pen-to-square btn-tab-edit" onclick="openEditDeviceModal(${dev.id})" title="Edit Device"></i>
    `;

    tabsContainer.appendChild(tab);
  });

  updateActiveDeviceUI();
}

function switchDevice(id) {
  activeDeviceId = id;
  saveData();
  renderDeviceTabs();
  updateEnergyUI();
}

function updateActiveDeviceUI() {
  const current = devices.find(d => d.id === activeDeviceId);
  if (!current) return;

  const tagElem = document.getElementById('active-device-tag');
  const btn = document.getElementById('power-btn');
  const text = document.getElementById('power-state-text');

  if (tagElem) tagElem.innerText = `${current.chip || 'ESP32-C3 #01'} (${current.watt || 50}W)`;

  if (current.state) {
    if (btn) btn.classList.add('active');
    if (text) {
      text.innerText = 'ON';
      text.className = 'state-on';
    }
  } else {
    if (btn) btn.classList.remove('active');
    if (text) {
      text.innerText = 'OFF';
      text.className = 'state-off';
    }
  }

  updateEnergyUI();
}

// ==========================================
// 9. EDIT & TAMBAH DEVICE
// ==========================================
let editingDeviceId = null;

function openEditDeviceModal(id = activeDeviceId) {
  editingDeviceId = id;
  const dev = devices.find(d => d.id === editingDeviceId);
  if (!dev) return;

  document.getElementById('edit-device-name').value = dev.name;
  document.getElementById('edit-device-watt').value = dev.watt || 50;
  document.getElementById('edit-device-chip').value = dev.chip || 'ESP32-C3 #01';
  document.getElementById('edit-device-modal').classList.remove('hidden');
}

function closeEditDeviceModal() {
  document.getElementById('edit-device-modal').classList.add('hidden');
}

function saveDeviceEdit() {
  const newName = document.getElementById('edit-device-name').value.trim();
  const newWatt = parseInt(document.getElementById('edit-device-watt').value) || 50;
  const newChip = document.getElementById('edit-device-chip').value.trim();

  if (!newName) {
    alert("Nama perangkat tidak boleh kosong!");
    return;
  }

  const dev = devices.find(d => d.id === editingDeviceId);
  if (dev) {
    const oldName = dev.name;
    dev.name = newName;
    dev.watt = newWatt;
    dev.chip = newChip || dev.chip;

    saveData();
    renderDeviceTabs();
    closeEditDeviceModal();
    addLog(`Perangkat diubah: "${oldName}" (${newWatt}W)`, 'info');
  }
}

function openDeviceModal() { document.getElementById('device-modal').classList.remove('hidden'); }
function closeDeviceModal() { document.getElementById('device-modal').classList.add('hidden'); }

function addNewDevice() {
  const name = document.getElementById('new-device-name').value.trim() || `Socket #${devices.length + 1}`;
  const watt = parseInt(document.getElementById('new-device-watt').value) || 50;
  const chip = document.getElementById('new-device-chip').value.trim() || `ESP32-C3 #${devices.length + 1}`;

  const newDev = { id: Date.now(), name, chip, watt, state: false, clicks: 0, uptimeSeconds: 0, schedules: [] };
  devices.push(newDev);
  activeDeviceId = newDev.id;

  saveData();
  closeDeviceModal();
  renderDeviceTabs();
  addLog(`Perangkat baru ditambahkan: ${name} (${watt}W)`, 'info');

  document.getElementById('new-device-name').value = '';
  document.getElementById('new-device-watt').value = '50';
  document.getElementById('new-device-chip').value = '';
}

// ==========================================
// 10. LOGIKA JADWAL OTOMATIS (SCHEDULING)
// ==========================================
function openScheduleModal() {
  renderScheduleList();
  document.getElementById('schedule-modal').classList.remove('hidden');
}

function closeScheduleModal() {
  document.getElementById('schedule-modal').classList.add('hidden');
}

function addScheduleRule() {
  const current = devices.find(d => d.id === activeDeviceId);
  if (!current) return;

  const timeInput = document.getElementById('schedule-time').value;
  const actionInput = document.getElementById('schedule-action').value;

  if (!timeInput) {
    alert("Silakan pilih jam terlebih dahulu!");
    return;
  }

  if (!current.schedules) current.schedules = [];

  const newRule = { id: Date.now(), time: timeInput, action: actionInput, active: true };
  current.schedules.push(newRule);

  saveData();
  renderScheduleList();
  addLog(`Jadwal ditambahkan [${current.name}]: Jam ${timeInput} (${actionInput})`, 'info');
}

function deleteScheduleRule(ruleId) {
  const current = devices.find(d => d.id === activeDeviceId);
  if (!current || !current.schedules) return;

  current.schedules = current.schedules.filter(s => s.id !== ruleId);
  saveData();
  renderScheduleList();
  addLog(`Jadwal dihapus dari [${current.name}]`, 'info');
}

function renderScheduleList() {
  const container = document.getElementById('schedule-list');
  if (!container) return;

  const current = devices.find(d => d.id === activeDeviceId);
  if (!current || !current.schedules || current.schedules.length === 0) {
    container.innerHTML = '<div style="color: var(--text-secondary); text-align: center;">Belum ada jadwal tersimpan.</div>';
    return;
  }

  container.innerHTML = '';
  current.schedules.forEach(rule => {
    const item = document.createElement('div');
    item.style.cssText = "display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.05);";
    const badgeColor = rule.action === 'ON' ? 'var(--accent-green)' : 'var(--accent-red)';
    
    item.innerHTML = `
      <span><i class="fa-regular fa-clock"></i> <b>${rule.time}</b> &mdash; <span style="color: ${badgeColor}; font-weight: 600;">${rule.action}</span></span>
      <i class="fa-solid fa-trash" style="color: var(--accent-red); cursor: pointer;" onclick="deleteScheduleRule(${rule.id})"></i>
    `;
    container.appendChild(item);
  });
}

function checkScheduleRules() {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const currentHHMM = `${hours}:${minutes}`;

  devices.forEach(dev => {
    if (dev.schedules && dev.schedules.length > 0) {
      dev.schedules.forEach(rule => {
        if (rule.active && rule.time === currentHHMM && rule.lastExecuted !== currentHHMM) {
          const targetState = rule.action === 'ON';

          if (dev.state !== targetState) {
            dev.state = targetState;
            saveData();

            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'TOGGLE_RELAY', state: dev.state }));
            }

            const msg = `Jadwal Otomatis: [${dev.name}] diubah ke ${rule.action}`;
            addLog(msg, 'info');
            sendDesktopNotification(`SmartSocket ${rule.action}`, msg);

            if (dev.id === activeDeviceId) {
              updateActiveDeviceUI();
              updateChart(dev.state ? 1 : 0);
            }
          }

          rule.lastExecuted = currentHHMM;
          saveData();
        }
      });
    }
  });
}

// ==========================================
// 11. LOGIKA PROFIL, PASSWORD KUAT & TOGGLE MATA
// ==========================================

function togglePasswordVisibility(inputId, iconElem) {
  const input = document.getElementById(inputId);
  if (!input) return;

  if (input.type === 'password') {
    input.type = 'text';
    iconElem.classList.remove('fa-eye');
    iconElem.classList.add('fa-eye-slash');
  } else {
    input.type = 'password';
    iconElem.classList.remove('fa-eye-slash');
    iconElem.classList.add('fa-eye');
  }
}

function openProfileModal() {
  if (!currentUser) return;

  document.getElementById('edit-username').value = currentUser.name || '';
  document.getElementById('edit-email').value = currentUser.email || '';

  // Selalu di-reset kosong agar password terisolasi & aman per-akun
  document.getElementById('edit-password').value = '';
  document.getElementById('edit-confirm-password').value = '';

  const avatarImg = document.getElementById('profile-avatar-img');
  const avatarIcon = document.getElementById('profile-avatar-icon');

  if (currentUser.picture) {
    avatarImg.src = currentUser.picture;
    avatarImg.classList.remove('hidden');
    avatarIcon.classList.add('hidden');
  } else {
    avatarImg.classList.add('hidden');
    avatarIcon.classList.remove('hidden');
  }

  document.getElementById('profile-modal').classList.remove('hidden');
}

function closeProfileModal() {
  document.getElementById('profile-modal').classList.add('hidden');
}

function saveProfileChanges() {
  const newName = document.getElementById('edit-username').value.trim();
  const newPassword = document.getElementById('edit-password').value.trim();
  const confirmPassword = document.getElementById('edit-confirm-password').value.trim();

  if (!newName) {
    alert('Nama tidak boleh kosong!');
    return;
  }

  // Jika menginputkan kata sandi baru
  if (newPassword || confirmPassword) {
    if (newPassword !== confirmPassword) {
      alert('Konfirmasi kata sandi tidak cocok! Pastikan kedua kolom kata sandi bernilai sama.');
      return;
    }

    // Validasi Password Kuat: Min 6 Karakter, 1 Huruf Besar, 1 Angka, 1 Simbol Khusus
    const passwordRegex = /^(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&^#\-_=+\/\\<>{}[\]]).{6,}$/;

    if (!passwordRegex.test(newPassword)) {
      alert('Kata sandi terlalu lemah!\n\nSyarat kata sandi:\n- Minimal 6 karakter\n- Memiliki minimal 1 Huruf Besar (A-Z)\n- Memiliki minimal 1 Angka (0-9)\n- Memiliki minimal 1 Karakter Khusus/Simbol (misal: @, #, $, !, %, dll)');
      return;
    }

    currentUser.password = newPassword;
  }

  currentUser.name = newName;
  localStorage.setItem('ss_current_user', JSON.stringify(currentUser));

  // Simpan ke database lokal users
  let usersList = JSON.parse(localStorage.getItem('ss_users')) || [];
  const existingIndex = usersList.findIndex(u => u.email === currentUser.email);

  if (existingIndex !== -1) {
    usersList[existingIndex].name = newName;
    if (newPassword) usersList[existingIndex].password = newPassword;
  } else {
    usersList.push({
      name: newName,
      email: currentUser.email,
      password: newPassword || ''
    });
  }

  localStorage.setItem('ss_users', JSON.stringify(usersList));

  document.getElementById('user-display-name').innerText = newName;

  const logMsg = newPassword 
    ? `Profil & kata sandi baru diperbarui untuk ${currentUser.email}`
    : `Profil diperbarui: Nama diubah menjadi "${newName}"`;

  addLog(logMsg, 'info');
  sendDesktopNotification("Profil Diperbarui", logMsg);

  closeProfileModal();
}

function openLogoutModal() { document.getElementById('logout-modal').classList.remove('hidden'); }
function closeLogoutModal() { document.getElementById('logout-modal').classList.add('hidden'); }

function confirmLogout() {
  closeLogoutModal();
  handleLogout();
}

// ==========================================
// 12. LOGS, TIMER & PWA REGISTRATION
// ==========================================
function updateChart(value) {
  const time = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

  chartHistoryLabels.shift();
  chartHistoryLabels.push(time);

  chartHistoryData.shift();
  chartHistoryData.push(value);

  saveData();

  usageChart.data.labels = chartHistoryLabels;
  usageChart.data.datasets[0].data = chartHistoryData;
  usageChart.update();
}

function setTimer(minutes) {
  clearTimer();
  let secondsLeft = minutes * 60;
  addLog(`Timer diatur: ${minutes} Menit`, 'info');

  timerInterval = setInterval(() => {
    secondsLeft--;
    const m = Math.floor(secondsLeft / 60);
    const s = secondsLeft % 60;
    document.getElementById('timer-display').innerText = `Mati dalam: ${m}m ${s}s`;

    if (secondsLeft <= 0) {
      clearTimer();
      const current = devices.find(d => d.id === activeDeviceId);
      if (current && current.state) togglePower();
      addLog('Timer Selesai: Sakelar dimatikan otomatis', 'off');
      sendDesktopNotification("Timer Selesai", "Sakelar dimatikan otomatis.");
    }
  }, 1000);
}

function clearTimer() {
  if (timerInterval) clearInterval(timerInterval);
  document.getElementById('timer-display').innerText = 'Timer: -';
}

function addLog(msg, type = 'info') {
  const time = new Date().toLocaleTimeString('id-ID');
  logsData.push({ time, message: msg, type });
  saveData();
  renderLogs();
}

function renderLogs() {
  const container = document.getElementById('logs-list');
  if (!container) return;

  container.innerHTML = '';

  logsData.forEach(row => {
    const div = document.createElement('div');
    div.className = `log-row ${row.type}`;
    div.innerHTML = `<span class="time">[${row.time}]</span> ${row.message}`;
    container.appendChild(div);
  });
  container.scrollTop = container.scrollHeight;
}

function exportLogs() {
  let csvContent = "data:text/csv;charset=utf-8,Waktu,Aktivitas\n";
  logsData.forEach(row => { csvContent += `"${row.time}","${row.message}"\n`; });
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `log_smart_socket_${currentUser?.email || 'user'}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// Registrasi Service Worker PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(() => console.log('PWA Service Worker Berhasil Terdaftar'))
      .catch((err) => console.log('PWA Registration Failed:', err));
  });
}