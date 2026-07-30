import { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const BIN_DASHBOARD_PASSWORD = import.meta.env.VITE_BIN_DASHBOARD_PASSWORD || 'admin123';
const wasteTypes = ['Paper', 'Plastic', 'Tin Can'];
const binWasteOptions = [
  { label: 'Plastic bottle', value: 'Plastic', icon: '🥤' },
  { label: 'Tin can', value: 'Tin Can', icon: '🥫' },
  { label: 'Paper', value: 'Paper', icon: '📄' },
];

const POINTS_PER_KG = {
  Paper: 5,
  Plastic: 8,
  'Tin Can': 8,
};

function getWasteLabel(value) {
  return binWasteOptions.find((option) => option.value === value)?.label || value;
}

function estimatePoints(wasteType, grams) {
  const rate = POINTS_PER_KG[wasteType] || 0;
  return Math.round(rate * (grams / 1000));
}

async function apiRequest(path, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const message = payload.message || payload.errors?.join(', ') || 'Request failed';
    throw new Error(message);
  }
  return payload;
}

function App() {
  const [publicMode, setPublicMode] = useState('auth');
  const [session, setSession] = useState(() => {
    const saved = localStorage.getItem('trashquest_session');
    return saved ? JSON.parse(saved) : null;
  });
  const [view, setView] = useState('scan');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState({
    profile: null,
    bins: [],
    disposals: [],
    rewards: [],
    quests: [],
    users: [],
    logs: [],
  });

  const token = session?.token;
  const isAdmin = session?.role === 'admin';

  const totals = useMemo(() => {
    const disposalPoints = data.disposals.reduce((sum, disposal) => sum + (disposal.pointsAwarded || 0), 0);
    const wasteKg = data.disposals.reduce((sum, disposal) => sum + (disposal.quantity || 0), 0);
    const collectionCount = data.bins.filter((bin) => bin.status === 'needs_collection').length;
    return { disposalPoints, wasteKg: wasteKg.toFixed(1), collectionCount };
  }, [data]);

  useEffect(() => {
    if (!token) return;
    refreshData();
  }, [token]);

  async function refreshData() {
    setLoading(true);
    setNotice('');
    const requests = [
      ['profile', apiRequest('/api/auth/me', { token })],
      ['bins', apiRequest('/api/bins', { token })],
      ['disposals', apiRequest('/api/disposals/me', { token })],
      ['rewards', apiRequest('/api/rewards', { token })],
      ['quests', apiRequest(isAdmin ? '/api/quests' : '/api/quests/available', { token })],
    ];

    if (isAdmin) {
      requests.push(['users', apiRequest('/api/users', { token })]);
      requests.push(['logs', apiRequest('/api/disposals', { token })]);
    }

    const results = await Promise.allSettled(requests.map(([, request]) => request));
    const nextData = { profile: null, bins: [], disposals: [], rewards: [], quests: [], users: [], logs: [] };
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        const key = requests[index][0];
        nextData[key] = key === 'profile' ? result.value.data || null : result.value.data || [];
      }
    });
    if (nextData.profile) {
      const updatedSession = { ...session, ...nextData.profile, token };
      localStorage.setItem('trashquest_session', JSON.stringify(updatedSession));
      setSession(updatedSession);
    }
    setData(nextData);
    setLoading(false);
  }

  function saveSession(user) {
    const cleanUser = { ...user };
    delete cleanUser.zone;
    localStorage.setItem('trashquest_session', JSON.stringify(cleanUser));
    setSession(cleanUser);
    setView(cleanUser.role === 'admin' ? 'admin-overview' : 'scan');
  }

  function logout() {
    localStorage.removeItem('trashquest_session');
    setSession(null);
    setView('scan');
    setData({ profile: null, bins: [], disposals: [], rewards: [], quests: [], users: [], logs: [] });
  }

  async function runAction(action, successMessage) {
    try {
      setLoading(true);
      setNotice('');
      const result = await action();
      setNotice(result?.message || successMessage);
      await refreshData();
      return result;
    } catch (error) {
      setNotice(error.message);
      return null;
    } finally {
      setLoading(false);
    }
  }

  if (!session) {
    if (publicMode === 'bin-display') {
      return <BinDisplayDashboard onExit={() => setPublicMode('auth')} />;
    }
    return <AuthScreen onLogin={saveSession} onOpenBinDisplay={() => setPublicMode('bin-display')} />;
  }

  if (!isAdmin) {
    return (
      <ResidentApp
        data={data}
        loading={loading}
        logout={logout}
        notice={notice}
        refreshData={refreshData}
        runAction={runAction}
        session={session}
        setView={setView}
        token={token}
        totals={totals}
        view={view}
      />
    );
  }

  return (
    <AdminApp
      data={data}
      loading={loading}
      logout={logout}
      notice={notice}
      refreshData={refreshData}
      runAction={runAction}
      session={session}
      setView={setView}
      token={token}
      totals={totals}
      view={view}
    />
  );
}

function AuthScreen({ onLogin, onOpenBinDisplay }) {
  const [mode, setMode] = useState('login');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    setBusy(true);
    setNotice('');

    try {
      const response = await apiRequest(`/api/auth/${mode}`, { method: 'POST', body });
      if (mode === 'login') {
        onLogin(response.data);
      } else {
        setNotice('Account created. You can sign in now.');
        setMode('login');
        event.currentTarget.reset();
      }
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <div className="auth-copy">
          <p className="eyebrow">TrashQuest</p>
          <h1>Scan the bin screen. Claim your points.</h1>
          <p>
            Residents use the phone dashboard to scan a QR token from the smart bin.
            Admins manage bins, quests, rewards, and station testing.
          </p>
          <button type="button" className="secondary-button bin-entry-button" onClick={onOpenBinDisplay}>
            Open bin dashboard
          </button>
          <p className="admin-entry-note">Admin only — password required to access the bin touch display.</p>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="segmented">
            <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
              Login
            </button>
            <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>
              Register
            </button>
          </div>

          {mode === 'register' && (
            <label>
              Name
              <input name="name" placeholder="Juan Dela Cruz" required />
            </label>
          )}

          <label>
            Email
            <input name="email" type="email" placeholder="you@example.com" required />
          </label>
          <label>
            Password
            <input name="password" type="password" minLength={6} placeholder="At least 6 characters" required />
          </label>

          {notice && <div className="notice compact">{notice}</div>}
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? 'Working...' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
      </section>
    </main>
  );
}

function BinDisplayDashboard({ onExit }) {
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [password, setPassword] = useState('');
  const [deviceKey, setDeviceKey] = useState(() => localStorage.getItem('trashquest_bin_device_key') || '');
  const [currentWaste, setCurrentWaste] = useState(binWasteOptions[0].value);
  const [grams, setGrams] = useState('');
  const [items, setItems] = useState([]);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [claim, setClaim] = useState(null);

  const totalGrams = items.reduce((sum, item) => sum + item.grams, 0);
  const groupedItems = binWasteOptions.map((option) => ({
    ...option,
    grams: items
      .filter((item) => item.wasteType === option.value)
      .reduce((sum, item) => sum + item.grams, 0),
  })).filter((item) => item.grams > 0);
  const estimatedTotalPoints = groupedItems.reduce(
    (sum, item) => sum + estimatePoints(item.value, item.grams),
    0
  );

  function unlock(event) {
    event.preventDefault();
    if (password !== BIN_DASHBOARD_PASSWORD) {
      setNotice('Incorrect display password.');
      return;
    }
    if (deviceKey.trim()) {
      localStorage.setItem('trashquest_bin_device_key', deviceKey.trim());
    }
    setNotice('');
    setIsUnlocked(true);
  }

  function saveDeviceKey(event) {
    event.preventDefault();
    localStorage.setItem('trashquest_bin_device_key', deviceKey.trim());
    setNotice('Device key saved for this bin display.');
  }

  function addWaste() {
    const parsedGrams = Number(grams);
    if (!currentWaste || !parsedGrams || parsedGrams <= 0) {
      setNotice('Select a waste type and enter weight in grams.');
      return;
    }
    setItems([
      ...items,
      {
        id: crypto.randomUUID(),
        wasteType: currentWaste,
        grams: Math.round(parsedGrams),
      },
    ]);
    setGrams('');
    setClaim(null);
    setNotice(`${getWasteLabel(currentWaste)} (${Math.round(parsedGrams)}g) added to session.`);
  }

  function removeItem(itemId) {
    setItems(items.filter((item) => item.id !== itemId));
    setClaim(null);
  }

  function clearSession() {
    setItems([]);
    setClaim(null);
    setNotice('');
  }

  function handleNotDone() {
    setNotice('Keep adding waste. Select a type and weight, then tap Add waste.');
  }

  async function finishSession() {
    if (!deviceKey.trim()) {
      setNotice('Enter this bin display device API key first.');
      return;
    }
    if (items.length === 0) {
      setNotice('Add at least one waste item before generating a QR code.');
      return;
    }

    setBusy(true);
    setNotice('');
    try {
      const claims = [];
      for (const group of groupedItems) {
        const response = await apiRequest('/api/disposals/claims', {
          method: 'POST',
          headers: { 'x-device-key': deviceKey.trim() },
          body: {
            wasteType: group.value,
            quantity: group.grams / 1000,
          },
        });
        const qrValue = response.data.claimToken;
        const qrImage = await QRCode.toDataURL(qrValue, {
          margin: 2,
          width: 360,
          color: {
            dark: '#10221c',
            light: '#ffffff',
          },
        });
        claims.push({
          wasteType: group.value,
          label: group.label,
          icon: group.icon,
          grams: group.grams,
          pointsAvailable: response.data.pointsAvailable,
          claimToken: qrValue,
          expiresAt: response.data.expiresAt,
          qrImage,
        });
      }

      setClaim({ claims });
      setItems([]);
      const qrCount = claims.length;
      setNotice(
        qrCount === 1
          ? 'QR code ready. Ask the resident to scan it with their phone.'
          : `${qrCount} QR codes ready — one per waste type. Scan each to claim points.`
      );
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  if (!isUnlocked) {
    return (
      <main className="bin-display-shell locked">
        <section className="bin-lock-panel">
          <p className="eyebrow">Admin access</p>
          <h1>Bin Dashboard</h1>
          <p>Enter the display password to open the bin touch screen. Residents cannot access this page.</p>
          <form onSubmit={unlock}>
            <label>
              Password
              <input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                placeholder="Display password"
                autoFocus
              />
            </label>
            <label>
              Bin device API key
              <input
                value={deviceKey}
                onChange={(event) => setDeviceKey(event.target.value)}
                placeholder="Paste this bin's device key (optional here)"
              />
            </label>
            {notice && <div className="notice compact">{notice}</div>}
            <button type="submit" className="primary-button">Unlock dashboard</button>
            <button type="button" className="secondary-button" onClick={onExit}>Back to login</button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="bin-display-shell">
      <header className="bin-display-header">
        <div>
          <p className="eyebrow">Smart bin touch screen</p>
          <h1>TrashQuest Bin</h1>
        </div>
        <button type="button" className="secondary-button" onClick={onExit}>Exit</button>
      </header>

      {notice && <div className="notice">{notice}</div>}

      <section className="bin-display-grid">
        <div className="bin-touch-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Step 1</p>
              <h2>What did the user drop?</h2>
            </div>
          </div>
          <div className="waste-touch-grid">
            {binWasteOptions.map((option) => (
              <button
                type="button"
                key={option.value}
                className={currentWaste === option.value ? 'active' : ''}
                onClick={() => setCurrentWaste(option.value)}
              >
                <span className="waste-icon">{option.icon}</span>
                {option.label}
              </button>
            ))}
          </div>

          <p className="selected-waste-note">
            Selected: <strong>{getWasteLabel(currentWaste)}</strong>
          </p>

          <label className="grams-input">
            Weight in grams
            <input
              value={grams}
              onChange={(event) => setGrams(event.target.value)}
              type="number"
              min="1"
              step="1"
              placeholder="Example: 250"
            />
          </label>

          <div className="weight-shortcuts">
            {[50, 100, 250, 500].map((weight) => (
              <button type="button" key={weight} onClick={() => setGrams(String(weight))}>
                {weight}g
              </button>
            ))}
          </div>

          <button type="button" className="primary-button huge-button" onClick={addWaste}>
            Add waste
          </button>
        </div>

        <div className="bin-touch-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Step 2</p>
              <h2>Session summary</h2>
            </div>
          </div>

          <div className="waste-summary">
            <strong>{totalGrams}g</strong>
            <span>Total waste weight</span>
            {groupedItems.length > 0 && (
              <span className="waste-summary-points">~{estimatedTotalPoints} points available</span>
            )}
          </div>

          {groupedItems.length > 0 && (
            <div className="waste-type-breakdown">
              {groupedItems.map((group) => (
                <article key={group.value}>
                  <span>{group.icon} {group.label}</span>
                  <strong>{group.grams}g</strong>
                </article>
              ))}
            </div>
          )}

          <div className="bin-items-list">
            {items.length === 0 && <EmptyState text="No waste added yet." />}
            {items.map((item) => (
              <article key={item.id}>
                <span>{binWasteOptions.find((option) => option.value === item.wasteType)?.icon}{' '}
                  {getWasteLabel(item.wasteType)}</span>
                <div className="bin-item-actions">
                  <strong>{item.grams}g</strong>
                  <button type="button" className="text-button" onClick={() => removeItem(item.id)} aria-label="Remove item">
                    Remove
                  </button>
                </div>
              </article>
            ))}
          </div>

          <div className="done-question">
            <h3>Are you done throwing waste?</h3>
            <div className="done-actions">
              <button type="button" className="primary-button huge-button" onClick={finishSession} disabled={busy || items.length === 0}>
                {busy ? 'Generating...' : 'Yes, show QR code'}
              </button>
              <button type="button" className="secondary-button huge-button" onClick={handleNotDone} disabled={items.length === 0}>
                No, add more
              </button>
            </div>
            <button type="button" className="text-button clear-session" onClick={clearSession} disabled={items.length === 0 && !claim}>
              Clear session
            </button>
          </div>
        </div>

        <div className="bin-touch-panel qr-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Step 3</p>
              <h2>Scan to claim points</h2>
            </div>
          </div>

          {claim?.claims?.length ? (
            <div className="qr-claim-list">
              {claim.claims.map((entry) => (
                <article key={entry.claimToken} className="qr-claim-card">
                  <div className="qr-claim-meta">
                    <strong>{entry.icon} {entry.label}</strong>
                    <span>{entry.grams}g · {entry.pointsAvailable} points</span>
                  </div>
                  <img src={entry.qrImage} alt={`QR code for ${entry.label}`} />
                  <code>{entry.claimToken}</code>
                </article>
              ))}
              <p>Open the resident app, tap Scan, and scan each QR code to collect points.</p>
              <button type="button" className="secondary-button" onClick={() => { setClaim(null); setNotice('Ready for the next resident.'); }}>
                Start new session
              </button>
            </div>
          ) : (
            <div className="qr-placeholder">QR code will appear here after you confirm you are done</div>
          )}
        </div>

        <form className="bin-device-panel" onSubmit={saveDeviceKey}>
          <label>
            Bin device API key
            <input
              value={deviceKey}
              onChange={(event) => setDeviceKey(event.target.value)}
              placeholder="Paste this bin's device key"
            />
          </label>
          <button type="submit" className="secondary-button">Save device key</button>
        </form>
      </section>
    </main>
  );
}

function ResidentApp({ data, loading, logout, notice, refreshData, runAction, session, setView, token, totals, view }) {
  const tabs = [
    { id: 'scan', label: 'Scan' },
    { id: 'wallet', label: 'Points' },
    { id: 'quests', label: 'Quests' },
    { id: 'rewards', label: 'Rewards' },
  ];

  return (
    <main className="resident-shell">
      <header className="resident-header">
        <div>
          <p className="eyebrow">Resident app</p>
          <h1>Hi, {session.name}</h1>
        </div>
        <button type="button" className="icon-button" onClick={logout} aria-label="Sign out">
          Exit
        </button>
      </header>

      {notice && <div className="notice">{notice}</div>}

      {view === 'scan' && <ResidentScan token={token} runAction={runAction} />}
      {view === 'wallet' && <ResidentWallet data={data} loading={loading} refreshData={refreshData} session={session} totals={totals} />}
      {view === 'quests' && <QuestView quests={data.quests} session={session} />}
      {view === 'rewards' && <RewardView rewards={data.rewards} token={token} runAction={runAction} />}

      <nav className="bottom-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={view === tab.id ? 'active' : ''}
            onClick={() => setView(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>
    </main>
  );
}

function ResidentScan({ token, runAction }) {
  const videoRef = useRef(null);
  const detectorRef = useRef(null);
  const streamRef = useRef(null);
  const scanTimerRef = useRef(null);
  const [manualToken, setManualToken] = useState('');
  const [scannerState, setScannerState] = useState('idle');
  const [scannerMessage, setScannerMessage] = useState('Point your camera at the QR code on the bin screen.');

  useEffect(() => {
    return () => stopCamera();
  }, []);

  async function claimToken(claimToken) {
    const normalizedToken = claimToken.trim();
    if (!normalizedToken) return null;
    const result = await runAction(
      () => apiRequest('/api/disposals/claim', { method: 'POST', token, body: { claimToken: normalizedToken } }),
      'Points claimed'
    );
    if (result) {
      setManualToken('');
      stopCamera();
      setScannerState('claimed');
      setScannerMessage(`Claimed ${result.data?.pointsAwarded || 0} points.`);
    }
    return result;
  }

  async function startCamera() {
    if (!('BarcodeDetector' in window)) {
      setScannerState('manual');
      setScannerMessage('Camera QR scanning is not supported in this browser. Paste the token instead.');
      return;
    }

    try {
      detectorRef.current = new window.BarcodeDetector({ formats: ['qr_code'] });
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      streamRef.current = stream;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setScannerState('scanning');
      setScannerMessage('Scanning bin QR code...');
      scanTimerRef.current = window.setInterval(scanFrame, 700);
    } catch (error) {
      setScannerState('manual');
      setScannerMessage(error.message || 'Camera permission was blocked. Paste the token instead.');
    }
  }

  async function scanFrame() {
    if (!videoRef.current || !detectorRef.current || videoRef.current.readyState < 2) return;
    try {
      const codes = await detectorRef.current.detect(videoRef.current);
      const value = codes[0]?.rawValue;
      if (value) {
        setScannerMessage('QR detected. Claiming points...');
        await claimToken(value);
      }
    } catch (error) {
      setScannerMessage('Scanner paused. Try again or paste the token.');
      stopCamera();
    }
  }

  function stopCamera() {
    if (scanTimerRef.current) {
      window.clearInterval(scanTimerRef.current);
      scanTimerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setScannerState((current) => (current === 'scanning' ? 'idle' : current));
  }

  function handleManualSubmit(event) {
    event.preventDefault();
    claimToken(manualToken);
  }

  return (
    <section className="phone-scan-card">
      <div className="scan-hero">
        <video ref={videoRef} className={scannerState === 'scanning' ? 'visible' : ''} playsInline muted />
        {scannerState !== 'scanning' && (
          <div className="scan-placeholder">
            <span className="scan-corners" />
            <strong>Scan QR</strong>
          </div>
        )}
      </div>

      <div className="scan-copy">
        <p className="eyebrow">Main action</p>
        <h2>Claim points from the bin screen</h2>
        <p>{scannerMessage}</p>
      </div>

      <div className="scan-actions">
        {scannerState === 'scanning' ? (
          <button type="button" className="secondary-button" onClick={stopCamera}>Stop camera</button>
        ) : (
          <button type="button" className="primary-button" onClick={startCamera}>Open camera scanner</button>
        )}
      </div>

      <form className="manual-claim" onSubmit={handleManualSubmit}>
        <label>
          Claim token
          <input
            value={manualToken}
            onChange={(event) => setManualToken(event.target.value)}
            placeholder="Paste token if camera cannot scan"
          />
        </label>
        <button type="submit" className="secondary-button">Claim manually</button>
      </form>
    </section>
  );
}

function ResidentWallet({ data, loading, refreshData, session, totals }) {
  const totalPoints = data.profile?.points ?? session.points ?? totals.disposalPoints;

  return (
    <div className="view-stack">
      <section className="metric-grid resident-metrics">
        <Metric label="Total points" value={totalPoints} />
        <Metric label="Waste recorded" value={`${totals.wasteKg} kg`} />
      </section>
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">History</p>
            <h3>Your claims</h3>
          </div>
          <button type="button" className="secondary-button small" onClick={refreshData} disabled={loading}>
            Refresh
          </button>
        </div>
        <DisposalTable disposals={data.disposals} compact />
      </section>
    </div>
  );
}

function AdminApp({ data, loading, logout, notice, refreshData, runAction, session, setView, token, totals, view }) {
  const tabs = [
    { id: 'admin-overview', label: 'Overview' },
    { id: 'admin-bins', label: 'Bins' },
    { id: 'admin-quests', label: 'Quests' },
    { id: 'admin-rewards', label: 'Rewards' },
    { id: 'admin-users', label: 'Users' },
  ];

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark">TQ</div>
          <div>
            <p className="eyebrow">Admin dashboard</p>
            <h1>TrashQuest</h1>
          </div>
        </div>

        <nav className="nav-list">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={view === tab.id ? 'active' : ''}
              onClick={() => setView(tab.id)}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="profile-box">
          <strong>{session.name}</strong>
          <span>{session.email}</span>
          <span className="badge">admin</span>
          <button type="button" className="ghost-button" onClick={logout}>
            Sign out
          </button>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <div>
            <p className="eyebrow">Operations</p>
            <h2>{tabs.find((tab) => tab.id === view)?.label || 'Overview'}</h2>
          </div>
          <button type="button" className="secondary-button" onClick={refreshData} disabled={loading}>
            Refresh
          </button>
        </header>

        {notice && <div className="notice">{notice}</div>}
        {view === 'admin-overview' && <AdminOverview data={data} totals={totals} />}
        {view === 'admin-bins' && <AdminBinTools data={data} token={token} runAction={runAction} loading={loading} />}
        {view === 'admin-quests' && <AdminQuestTools quests={data.quests} token={token} runAction={runAction} loading={loading} />}
        {view === 'admin-rewards' && <AdminRewardTools rewards={data.rewards} token={token} runAction={runAction} loading={loading} />}
        {view === 'admin-users' && <AdminUsers users={data.users} token={token} runAction={runAction} />}
      </section>
    </main>
  );
}

function AdminOverview({ data, totals }) {
  return (
    <div className="view-stack">
      <section className="metric-grid">
        <Metric label="Resident points" value={totals.disposalPoints} />
        <Metric label="Waste recorded" value={`${totals.wasteKg} kg`} />
        <Metric label="Active quests" value={data.quests.filter((quest) => quest.status !== 'closed').length} />
        <Metric label="Bins needing collection" value={totals.collectionCount} tone="warning" />
      </section>
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Audit</p>
            <h3>Recent disposals</h3>
          </div>
        </div>
        <DisposalTable disposals={data.logs.slice(0, 10)} admin />
      </section>
    </div>
  );
}

function AdminBinTools({ data, token, runAction, loading }) {
  const [createdKey, setCreatedKey] = useState('');
  const [levels, setLevels] = useState({});

  async function createBin(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const acceptedWasteTypes = wasteTypes.filter((type) => form.getAll('acceptedWasteTypes').includes(type));
    const body = {
      code: form.get('code'),
      location: form.get('location'),
      capacity: Number(form.get('capacity') || 100),
      acceptedWasteTypes,
    };
    const result = await runAction(
      () => apiRequest('/api/bins', { method: 'POST', token, body }),
      'Bin created'
    );
    if (result?.data?.deviceApiKey) setCreatedKey(result.data.deviceApiKey);
    if (result) event.currentTarget.reset();
  }

  async function createDeviceClaim(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = await runAction(
      () => apiRequest('/api/disposals/claims', {
        method: 'POST',
        body: {
          wasteType: form.get('wasteType'),
          quantity: Number(form.get('quantity')),
        },
        headers: { 'x-device-key': form.get('deviceApiKey') },
      }),
      'Claim token created'
    );
    if (result?.data?.claimToken) setCreatedKey(result.data.claimToken);
  }

  return (
    <div className="view-stack">
      <section className="admin-grid">
        <AdminForm title="Add bin" eyebrow="Stations" onSubmit={createBin}>
          <label>Code<input name="code" placeholder="BIN-A01" required /></label>
          <label>Location<input name="location" placeholder="Main gate" /></label>
          <label>Capacity<input name="capacity" type="number" min="1" defaultValue="100" /></label>
          <fieldset>
            <legend>Accepted waste</legend>
            {wasteTypes.map((type) => (
              <label className="check-row" key={type}>
                <input type="checkbox" name="acceptedWasteTypes" value={type} defaultChecked />
                {type}
              </label>
            ))}
          </fieldset>
          <button className="primary-button" type="submit" disabled={loading}>Create bin</button>
        </AdminForm>

        <AdminForm title="Station claim test" eyebrow="Device flow" onSubmit={createDeviceClaim}>
          <label className="wide">Device API key<input name="deviceApiKey" placeholder="Paste a bin device key" required /></label>
          <label>
            Waste type
            <select name="wasteType" required>
              {wasteTypes.map((type) => <option key={type}>{type}</option>)}
            </select>
          </label>
          <label>Quantity kg<input name="quantity" type="number" step="0.1" min="0.1" defaultValue="1" required /></label>
          <button className="secondary-button" type="submit" disabled={loading}>Generate claim token</button>
        </AdminForm>
      </section>

      {createdKey && (
        <section className="panel highlight-panel">
          <p className="eyebrow">Save or display this value</p>
          <code>{createdKey}</code>
        </section>
      )}

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Maintenance</p>
            <h3>Smart bins</h3>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Location</th>
                <th>Fill</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.bins.map((bin) => (
                <tr key={bin._id}>
                  <td>{bin.code}</td>
                  <td>{bin.location || 'Unassigned'}</td>
                  <td>
                    <input
                      className="tiny-input"
                      type="number"
                      min="0"
                      max="100"
                      value={levels[bin._id] ?? bin.fillLevel ?? 0}
                      onChange={(event) => setLevels({ ...levels, [bin._id]: event.target.value })}
                    />
                  </td>
                  <td>{bin.status}</td>
                  <td className="row-actions">
                    <button
                      type="button"
                      className="secondary-button small"
                      onClick={() =>
                        runAction(
                          () => apiRequest(`/api/bins/${bin._id}/fill-level`, {
                            method: 'PUT',
                            token,
                            body: { fillLevel: Number(levels[bin._id] ?? bin.fillLevel ?? 0) },
                          }),
                          'Fill level updated'
                        )
                      }
                    >
                      Set fill
                    </button>
                    <button
                      type="button"
                      className="secondary-button small"
                      onClick={() =>
                        runAction(
                          () => apiRequest(`/api/bins/${bin._id}/regenerate-key`, { method: 'PUT', token }),
                          'Device key rotated'
                        )
                      }
                    >
                      Rotate key
                    </button>
                    <button
                      type="button"
                      className="danger-button small"
                      onClick={() =>
                        runAction(
                          () => apiRequest(`/api/bins/${bin._id}`, { method: 'DELETE', token }),
                          'Bin deactivated'
                        )
                      }
                    >
                      Deactivate
                    </button>
                  </td>
                </tr>
              ))}
              {data.bins.length === 0 && <TableEmpty colSpan={5} text="No bins found." />}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function AdminQuestTools({ quests, token, runAction, loading }) {
  async function createQuest(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const wasteType = form.get('wasteType');
    const result = await runAction(
      () => apiRequest('/api/quests', {
        method: 'POST',
        token,
        body: {
          title: form.get('title'),
          description: form.get('description'),
          wasteType: wasteType || null,
          targetCount: Number(form.get('targetCount')),
          pointsReward: Number(form.get('pointsReward')),
          expiryDate: form.get('expiryDate'),
        },
      }),
      'Quest created'
    );
    if (result) event.currentTarget.reset();
  }

  return (
    <div className="view-stack">
      <AdminForm title="Add quest" eyebrow="Goals" onSubmit={createQuest}>
        <label>Title<input name="title" placeholder="Plastic Patrol" required /></label>
        <label>Description<input name="description" placeholder="Collect clean plastic waste" /></label>
        <label>
          Waste type
          <select name="wasteType">
            <option value="">Any waste</option>
            {wasteTypes.map((type) => <option key={type}>{type}</option>)}
          </select>
        </label>
        <label>Target<input name="targetCount" type="number" min="1" defaultValue="5" required /></label>
        <label>Reward points<input name="pointsReward" type="number" min="0" defaultValue="50" required /></label>
        <label>Expiry<input name="expiryDate" type="datetime-local" required /></label>
        <button className="primary-button" type="submit" disabled={loading}>Create quest</button>
      </AdminForm>
      <QuestView quests={quests} session={null} admin />
    </div>
  );
}

function AdminRewardTools({ rewards, token, runAction, loading }) {
  async function createReward(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = await runAction(
      () => apiRequest('/api/rewards', {
        method: 'POST',
        token,
        body: {
          name: form.get('name'),
          description: form.get('description'),
          pointsCost: Number(form.get('pointsCost')),
          stock: Number(form.get('stock')),
        },
      }),
      'Reward created'
    );
    if (result) event.currentTarget.reset();
  }

  return (
    <div className="view-stack">
      <AdminForm title="Add reward" eyebrow="Catalog" onSubmit={createReward}>
        <label>Name<input name="name" placeholder="Eco voucher" required /></label>
        <label>Description<input name="description" placeholder="Redeem at the admin booth" /></label>
        <label>Points cost<input name="pointsCost" type="number" min="0" defaultValue="100" required /></label>
        <label>Stock<input name="stock" type="number" min="0" defaultValue="10" required /></label>
        <button className="primary-button" type="submit" disabled={loading}>Create reward</button>
      </AdminForm>
      <RewardView rewards={rewards} token={token} runAction={runAction} />
      <AdminRedemptions rewards={rewards} token={token} runAction={runAction} />
    </div>
  );
}

function QuestView({ quests, session, admin = false }) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Community goals</p>
          <h3>{admin ? 'All quests' : 'Available quests'}</h3>
        </div>
      </div>
      <div className="item-grid">
        {quests.length === 0 && <EmptyState text="No quests are available right now." />}
        {quests.map((quest) => {
          const participantCount = quest.participants?.length || 0;
          const userProgress = quest.participants?.find((participant) => {
            const participantId = participant.user?._id || participant.user;
            return participantId?.toString() === session?._id?.toString();
          });
          const progress = userProgress?.progress || 0;
          const target = quest.targetCount || 1;
          const progressPercent = Math.min(100, Math.round((progress / target) * 100));

          return (
            <article className="item-card" key={quest._id}>
              <div>
                <span className="badge">{quest.wasteType || 'Any waste'}</span>
                <h4>{quest.title}</h4>
                <p>{quest.description || 'Complete the target before the expiry date.'}</p>
              </div>
              <dl>
                <div><dt>Target</dt><dd>{quest.targetCount}</dd></div>
                <div><dt>Reward</dt><dd>{quest.pointsReward} pts</dd></div>
                <div><dt>{admin ? 'Tracked' : 'Progress'}</dt><dd>{admin ? participantCount : `${progress}/${target}`}</dd></div>
              </dl>
              {!admin && (
                <div className="quest-progress">
                  <div className="progress-wrap">
                    <span style={{ width: `${progressPercent}%` }} />
                    <strong>{userProgress?.completed ? 'Completed' : `${progressPercent}%`}</strong>
                  </div>
                  <p>{userProgress?.completed ? 'Reward points added automatically.' : 'Progress updates when you claim matching waste.'}</p>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function RewardView({ rewards, token, runAction }) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Rewards catalog</p>
          <h3>Redeem points</h3>
        </div>
      </div>
      <div className="item-grid">
        {rewards.length === 0 && <EmptyState text="No rewards have been added yet." />}
        {rewards.map((reward) => (
          <article className="item-card" key={reward._id}>
            <div>
              <span className={reward.status === 'active' ? 'badge success' : 'badge'}>{reward.status}</span>
              <h4>{reward.name}</h4>
              <p>{reward.description || 'Reward available from your community admin.'}</p>
            </div>
            <dl>
              <div><dt>Cost</dt><dd>{reward.pointsCost} pts</dd></div>
              <div><dt>Stock</dt><dd>{reward.stock}</dd></div>
            </dl>
            <button
              type="button"
              className="primary-button"
              disabled={reward.status !== 'active' || reward.stock <= 0}
              onClick={() =>
                runAction(
                  () => apiRequest(`/api/rewards/${reward._id}/redeem`, { method: 'POST', token }),
                  'Reward redeemed'
                )
              }
            >
              Redeem
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

function AdminRedemptions({ rewards, token, runAction }) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Fulfillment</p>
          <h3>Reward redemptions</h3>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Reward</th>
              <th>Cost</th>
              <th>Stock</th>
              <th>Pending</th>
            </tr>
          </thead>
          <tbody>
            {rewards.map((reward) => {
              const pending = reward.redemptions?.filter((redemption) => redemption.status === 'pending') || [];
              return (
                <tr key={reward._id}>
                  <td>{reward.name}</td>
                  <td>{reward.pointsCost}</td>
                  <td>{reward.stock}</td>
                  <td className="row-actions">
                    {pending.length === 0 && 'None'}
                    {pending.map((redemption) => (
                      <button
                        type="button"
                        className="secondary-button small"
                        key={redemption._id}
                        onClick={() =>
                          runAction(
                            () => apiRequest(`/api/rewards/${reward._id}/redemptions/${redemption._id}/claim`, {
                              method: 'PUT',
                              token,
                            }),
                            'Redemption claimed'
                          )
                        }
                      >
                        Claim {redemption.pointsSpent} pts
                      </button>
                    ))}
                  </td>
                </tr>
              );
            })}
            {rewards.length === 0 && <TableEmpty colSpan={4} text="No rewards found." />}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AdminUsers({ users, token, runAction }) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Residents</p>
          <h3>User directory</h3>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Points</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user._id}>
                <td>{user.name}</td>
                <td>{user.email}</td>
                <td>{user.points || 0}</td>
                <td>{user.status}</td>
                <td>
                  <button
                    type="button"
                    className="danger-button small"
                    disabled={user.status === 'inactive'}
                    onClick={() =>
                      runAction(
                        () => apiRequest(`/api/users/${user._id}`, { method: 'DELETE', token }),
                        'User deactivated'
                      )
                    }
                  >
                    Deactivate
                  </button>
                </td>
              </tr>
            ))}
            {users.length === 0 && <TableEmpty colSpan={5} text="No users found." />}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AdminForm({ title, eyebrow, onSubmit, children }) {
  return (
    <form className="panel admin-form" onSubmit={onSubmit}>
      <div className="section-heading">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h3>{title}</h3>
        </div>
      </div>
      <div className="form-grid">{children}</div>
    </form>
  );
}

function Metric({ label, value, tone = 'default' }) {
  return (
    <article className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function DisposalTable({ disposals, admin = false, compact = false }) {
  return (
    <div className={compact ? 'claim-list' : 'table-wrap'}>
      {compact ? (
        <>
          {disposals.map((disposal) => (
            <article className="claim-row" key={disposal._id}>
              <div>
                <strong>{disposal.wasteType}</strong>
                <span>{disposal.bin?.code || 'Smart bin'} · {formatDate(disposal.createdAt)}</span>
              </div>
              <b>{disposal.pointsAwarded} pts</b>
            </article>
          ))}
          {disposals.length === 0 && <EmptyState text="No disposal records yet." />}
        </>
      ) : (
        <table>
          <thead>
            <tr>
              {admin && <th>User</th>}
              <th>Bin</th>
              <th>Waste</th>
              <th>Quantity</th>
              <th>Points</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            {disposals.map((disposal) => (
              <tr key={disposal._id}>
                {admin && <td>{disposal.user?.name || 'Unknown'}</td>}
                <td>{disposal.bin?.code || 'Unknown'}</td>
                <td>{disposal.wasteType}</td>
                <td>{disposal.quantity} kg</td>
                <td>{disposal.pointsAwarded}</td>
                <td>{formatDate(disposal.createdAt)}</td>
              </tr>
            ))}
            {disposals.length === 0 && (
              <TableEmpty colSpan={admin ? 6 : 5} text="No disposal records yet." />
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

function EmptyState({ text }) {
  return <div className="empty-state">{text}</div>;
}

function TableEmpty({ colSpan, text }) {
  return (
    <tr>
      <td colSpan={colSpan} className="table-empty">{text}</td>
    </tr>
  );
}

function formatDate(date) {
  if (!date) return 'Not recorded';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date));
}

export default App;
