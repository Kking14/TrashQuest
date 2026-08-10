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

function getPasswordStrength(password) {
  const checks = [
    password.length >= 8,
    password.length >= 12,
    /[a-z]/.test(password) && /[A-Z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ];
  const score = checks.filter(Boolean).length;
  if (!password) return { score: 0, label: 'Enter a password', tone: 'empty' };
  if (score <= 2) return { score, label: 'Weak', tone: 'weak' };
  if (score <= 3) return { score, label: 'Fair', tone: 'fair' };
  if (score === 4) return { score, label: 'Strong', tone: 'strong' };
  return { score, label: 'Very strong', tone: 'very-strong' };
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
      requests.push(['users', apiRequest('/api/users?limit=500&sortBy=name&sortOrder=asc', { token })]);
      requests.push(['logs', apiRequest('/api/disposals?limit=500', { token })]);
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
  const [registrationPassword, setRegistrationPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const passwordStrength = getPasswordStrength(registrationPassword);

  async function handleSubmit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    if (mode === 'register' && registrationPassword !== confirmPassword) {
      setNotice('Passwords do not match.');
      return;
    }
    setBusy(true);
    setNotice('');

    try {
      const response = await apiRequest(`/api/auth/${mode}`, { method: 'POST', body });
      if (mode === 'login') {
        onLogin(response.data);
      } else {
        setNotice('Account created. You can sign in now.');
        setMode('login');
        setRegistrationPassword('');
        setConfirmPassword('');
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
          <div className="landing-art" aria-hidden="true">
            <span>♻</span>
            <i />
            <i />
            <i />
          </div>
          <div className="landing-brand"><span>TQ</span><strong>TrashQuest</strong></div>
          <p className="eyebrow landing-kicker">Smart recycling for every barangay</p>
          <h1>Scan the bin screen. Claim your points.</h1>
          <p>
            Turn everyday waste into community rewards. Drop accepted recyclables,
            scan your session, and earn points while helping keep your barangay clean.
          </p>
          <div className="landing-features" aria-label="Accepted materials">
            <span>🥤 Plastic bottles</span>
            <span>🥫 Tin cans</span>
            <span>📄 Paper</span>
          </div>
          <button type="button" className="secondary-button bin-entry-button" onClick={onOpenBinDisplay}>
            Open station display
          </button>
          <p className="admin-entry-note">For authorized TrashQuest station screens.</p>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="auth-form-heading">
            <p className="eyebrow">Resident portal</p>
            <h2>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h2>
            <p>{mode === 'login' ? 'Sign in to view your points and quests.' : 'Register to start earning rewards for recycling.'}</p>
          </div>
          <div className="segmented">
            <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
              Login
            </button>
            <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>
              Register
            </button>
          </div>

          {mode === 'register' && (
            <div className="registration-name-grid">
              <label>
                Last name
                <input name="lastName" placeholder="Dela Cruz" autoComplete="family-name" required />
              </label>
              <label>
                First name
                <input name="firstName" placeholder="Juan" autoComplete="given-name" required />
              </label>
              <label>
                MI
                <input name="middleInitial" placeholder="—" maxLength="1" autoComplete="additional-name" aria-label="Middle initial (optional)" />
              </label>
            </div>
          )}

          <label>
            Email
            <input name="email" type="email" placeholder="you@example.com" required />
          </label>
          <label>
            Password
            {mode === 'register' ? (
              <>
                <input
                  name="password"
                  type="password"
                  minLength={8}
                  value={registrationPassword}
                  onChange={(event) => setRegistrationPassword(event.target.value)}
                  placeholder="At least 8 characters"
                  autoComplete="new-password"
                  required
                />
                <div className={`password-strength ${passwordStrength.tone}`}>
                  <div>{[1, 2, 3, 4, 5].map((step) => <i key={step} className={step <= passwordStrength.score ? 'filled' : ''} />)}</div>
                  <span>{passwordStrength.label}</span>
                </div>
                <small className="password-hint">Use uppercase, lowercase, a number, and preferably a symbol.</small>
              </>
            ) : (
              <input name="password" type="password" placeholder="Your password" autoComplete="current-password" required />
            )}
          </label>

          {mode === 'register' && (
            <label>
              Confirm password
              <input
                name="confirmPassword"
                type="password"
                minLength={8}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder="Type your password again"
                autoComplete="new-password"
                required
              />
              {confirmPassword && (
                <small className={registrationPassword === confirmPassword ? 'password-match valid' : 'password-match invalid'}>
                  {registrationPassword === confirmPassword ? 'Passwords match' : 'Passwords do not match'}
                </small>
              )}
            </label>
          )}

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
  const [displayState, setDisplayState] = useState('ready');
  const [detectedItem, setDetectedItem] = useState(null);
  const detectionTimer = useRef(null);

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

  useEffect(() => () => clearTimeout(detectionTimer.current), []);

  // Temporary test controls call this now. Later, the hardware bridge can call
  // this same function with the YOLO/sensor result and measured weight.
  function handleWasteDetected(wasteType, detectedGrams) {
    if (displayState === 'detecting' || displayState === 'qr') return;
    const option = binWasteOptions.find((entry) => entry.value === wasteType);
    const normalizedGrams = Math.max(1, Math.round(Number(detectedGrams) || 100));
    setClaim(null);
    setNotice('');
    setDetectedItem({ ...option, grams: normalizedGrams });
    setDisplayState('detecting');
    clearTimeout(detectionTimer.current);
    detectionTimer.current = setTimeout(() => {
      setItems((currentItems) => [
        ...currentItems,
        { id: crypto.randomUUID(), wasteType, grams: normalizedGrams },
      ]);
      setDisplayState('recognized');
    }, 900);
  }

  function waitForNextItem() {
    setDetectedItem(null);
    setDisplayState('ready');
    setNotice('');
  }

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
    setDetectedItem(null);
    setDisplayState('ready');
    setNotice('');
  }

  function handleNotDone() {
    setNotice('Keep adding waste. Select a type and weight, then tap Add waste.');
  }

  async function finishSession() {
    if (items.length === 0) {
      setNotice('Add at least one waste item before generating a QR code.');
      return;
    }

    setBusy(true);
    setDisplayState('qr');
    setNotice('');
    try {
      const claims = [];
      for (const group of groupedItems) {
        let claimData;
        if (deviceKey.trim()) {
          const response = await apiRequest('/api/disposals/claims', {
            method: 'POST',
            headers: { 'x-device-key': deviceKey.trim() },
            body: {
              wasteType: group.value,
              quantity: group.grams / 1000,
            },
          });
          claimData = response.data;
        } else {
          claimData = {
            claimToken: `trashquest-test:${group.value}:${group.grams}:${Date.now()}`,
            pointsAvailable: estimatePoints(group.value, group.grams),
            expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          };
        }
        claims.push({
          wasteType: group.value,
          label: group.label,
          icon: group.icon,
          grams: group.grams,
          pointsAvailable: claimData.pointsAvailable,
          claimToken: claimData.claimToken,
          expiresAt: claimData.expiresAt,
        });
      }

      let sessionCode;
      if (deviceKey.trim()) {
        const sessionResponse = await apiRequest('/api/disposals/sessions', {
          method: 'POST',
          headers: { 'x-device-key': deviceKey.trim() },
          body: { claimTokens: claims.map((entry) => entry.claimToken) },
        });
        sessionCode = sessionResponse.data.sessionCode;
      } else {
        sessionCode = `TQ-TEST${Math.floor(10 + Math.random() * 90)}`;
      }
      const sessionValue = JSON.stringify({
        type: 'trashquest-session',
        version: 1,
        sessionCode,
      });
      const qrImage = await QRCode.toDataURL(sessionValue, {
        margin: 2,
        width: 420,
        errorCorrectionLevel: 'M',
        color: { dark: '#10221c', light: '#ffffff' },
      });
      setClaim({
        claims,
        qrImage,
        sessionCode,
        totalGrams: claims.reduce((sum, entry) => sum + entry.grams, 0),
        totalPoints: claims.reduce((sum, entry) => sum + entry.pointsAvailable, 0),
      });
      setItems([]);
      setNotice('Session QR code ready. Ask the resident to scan it once.');
    } catch (error) {
      setNotice(error.message);
      setDisplayState('recognized');
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
    <main className={`bin-display-shell kiosk-state-${displayState}`}>
      <header className="kiosk-header">
        <div className="kiosk-brand"><span>TQ</span><strong>TrashQuest</strong></div>
        <div className="station-status"><i /> Station online</div>
        <button type="button" className="kiosk-exit" onClick={onExit}>Exit display</button>
      </header>

      <section className="kiosk-stage">
        {displayState === 'ready' && (
          <div className="kiosk-message ready-message">
            <div className="drop-illustration" aria-hidden="true">
              <span className="floating-item">♻</span>
              <span className="drop-arrow">↓</span>
              <div className="bin-opening"><i /><i /><i /></div>
            </div>
            <p className="kiosk-kicker">Smart waste station</p>
            <h1>Drop an item to begin</h1>
            <p>One item at a time. We’ll identify and sort it automatically.</p>
          </div>
        )}

        {displayState === 'detecting' && (
          <div className="kiosk-message detecting-message">
            <div className="scanner-orb"><span>{detectedItem?.icon}</span><i /></div>
            <p className="kiosk-kicker">Item detected</p>
            <h1>Analyzing your item…</h1>
            <p>Our sensors and AI are finding the correct bin.</p>
            <div className="scan-progress"><i /></div>
          </div>
        )}

        {displayState === 'recognized' && detectedItem && (
          <div className="kiosk-message success-message">
            <div className={`result-icon result-${detectedItem.value.toLowerCase().replace(' ', '-')}`}>
              <span>{detectedItem.icon}</span><i>✓</i>
            </div>
            <p className="kiosk-kicker">Sorted successfully</p>
            <h1>{detectedItem.label}</h1>
            <p>{detectedItem.grams}g added · approximately {estimatePoints(detectedItem.value, detectedItem.grams)} {estimatePoints(detectedItem.value, detectedItem.grams) === 1 ? 'point' : 'points'}</p>
            <div className="result-actions">
              <button type="button" className="kiosk-primary" onClick={waitForNextItem}>Drop another item</button>
              <button type="button" className="kiosk-secondary" onClick={finishSession}>I’m done — show QR</button>
            </div>
          </div>
        )}

        {displayState === 'qr' && (
          <div className="kiosk-message qr-message">
            <p className="kiosk-kicker">Session complete</p>
            <h1>Scan to claim your points</h1>
            {busy && <div className="qr-loader">Creating your QR code…</div>}
            {notice && !claim && <div className="kiosk-error">{notice}</div>}
            {claim?.claims?.length > 0 && (
              <>
                <div className="kiosk-qr-list single-session-qr">
                  <article>
                    <img src={claim.qrImage} alt="QR code for this disposal session" />
                    <strong>{claim.claims.map((entry) => entry.icon).join(' ')} Complete session</strong>
                    <span>{claim.totalGrams}g · {claim.totalPoints} {claim.totalPoints === 1 ? 'point' : 'points'}</span>
                  </article>
                </div>
                <div className="session-code-block">
                  <span>Or enter this code in the resident portal</span>
                  <strong>{claim.sessionCode}</strong>
                  <small>Code expires with this disposal session.</small>
                </div>
                {!deviceKey.trim() && <p className="test-qr-note">Test QR only — add a device key for claimable points.</p>}
                <button type="button" className="kiosk-primary" onClick={clearSession}>Finish & reset station</button>
              </>
            )}
          </div>
        )}
      </section>

      {items.length > 0 && displayState !== 'qr' && (
        <aside className="session-pill">
          <span>{items.length} {items.length === 1 ? 'item' : 'items'}</span>
          <strong>{totalGrams}g · ~{estimatedTotalPoints} pts</strong>
        </aside>
      )}

      <aside className="hardware-test-panel">
        <span>Hardware test controls</span>
        <div>
          {binWasteOptions.map((option, index) => (
            <button
              type="button"
              key={option.value}
              onClick={() => handleWasteDetected(option.value, [80, 45, 25][index])}
              disabled={displayState === 'detecting' || displayState === 'qr'}
            >
              {option.icon} Simulate {option.label}
            </button>
          ))}
        </div>
        <small>Temporary — replace these buttons with sensor/YOLO events.</small>
      </aside>
    </main>
  );

  /* Legacy manual dashboard retained temporarily for backend reference.
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
  ); */
}

function ResidentApp({ data, loading, logout, notice, refreshData, runAction, session, setView, token, totals, view }) {
  const tabs = [
    { id: 'scan', label: 'Scan', icon: '⌗' },
    { id: 'wallet', label: 'Points', icon: '◉' },
    { id: 'quests', label: 'Quests', icon: '✓' },
    { id: 'rewards', label: 'Rewards', icon: '◇' },
  ];

  return (
    <main className="resident-shell">
      <header className="resident-header">
        <div className="resident-identity">
          <div className="resident-logo">TQ</div>
          <div>
            <p className="eyebrow">Welcome back</p>
            <h1>Hi, {session.firstName || session.name}</h1>
          </div>
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
            <span className="tab-icon" aria-hidden="true">{tab.icon}</span>
            <span>{tab.label}</span>
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
    let claimTokens = [normalizedToken];
    let sessionCode = /^TQ-[A-Z0-9]{6}$/i.test(normalizedToken) ? normalizedToken.toUpperCase() : null;
    try {
      const sessionPayload = JSON.parse(normalizedToken);
      if (sessionPayload.type === 'trashquest-session' && sessionPayload.sessionCode) {
        sessionCode = String(sessionPayload.sessionCode).toUpperCase();
        claimTokens = [];
      } else if (sessionPayload.type === 'trashquest-session' && Array.isArray(sessionPayload.claimTokens)) {
        claimTokens = sessionPayload.claimTokens.filter((entry) => typeof entry === 'string' && entry.trim());
      }
    } catch {
      // A plain token is the legacy single-disposal QR format.
    }
    if (!sessionCode && claimTokens.length === 0) return null;
    const result = await runAction(
      () => apiRequest('/api/disposals/claim', {
        method: 'POST',
        token,
        body: sessionCode ? { sessionCode } : { claimTokens },
      }),
      'Points claimed'
    );
    if (result) {
      setManualToken('');
      stopCamera();
      setScannerState('claimed');
      const pointsClaimed = result.data?.totalPoints ?? result.data?.pointsAwarded ?? 0;
      setScannerMessage(`Session claimed. You earned ${pointsClaimed} ${pointsClaimed === 1 ? 'point' : 'points'}.`);
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
          Session code
          <input
            value={manualToken}
            onChange={(event) => setManualToken(event.target.value)}
            placeholder="Example: TQ-AB23CD"
          />
        </label>
        <button type="submit" className="secondary-button">Claim with code</button>
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
    { id: 'admin-overview', label: 'Overview', icon: '⌂' },
    { id: 'admin-bins', label: 'Bins', icon: '▣' },
    { id: 'admin-quests', label: 'Quests', icon: '✓' },
    { id: 'admin-rewards', label: 'Rewards', icon: '◇' },
    { id: 'admin-users', label: 'Residents', icon: '◎' },
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
              <span className="nav-icon" aria-hidden="true">{tab.icon}</span>
              <span>{tab.label}</span>
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
            <p className="eyebrow">Barangay operations · {new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', year: 'numeric' }).format(new Date())}</p>
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
  const [selectedUser, setSelectedUser] = useState(null);
  const userRows = data.users.map((user) => {
    const history = data.logs.filter((log) => {
      const logUserId = log.user?._id || log.user;
      return logUserId?.toString() === user._id?.toString();
    });
    return {
      ...user,
      history,
      wasteKg: history.reduce((sum, log) => sum + (log.quantity || 0), 0),
      earnedPoints: history.reduce((sum, log) => sum + (log.pointsAwarded || 0), 0),
    };
  });

  return (
    <div className="view-stack">
      <section className="metric-grid">
        <Metric label="Resident points" value={totals.disposalPoints} />
        <Metric label="Waste recorded" value={`${totals.wasteKg} kg`} />
        <Metric label="Current quests" value={data.quests.filter((quest) => quest.status !== 'closed' && new Date(quest.expiryDate) >= new Date()).length} />
        <Metric label="Bins needing collection" value={totals.collectionCount} tone="warning" />
      </section>
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Resident activity</p>
            <h3>Disposal history by resident</h3>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Resident</th><th>Disposals</th><th>Waste</th><th>Points earned</th><th>Last activity</th></tr></thead>
            <tbody>
              {userRows.map((user) => (
                <tr className="clickable-row" key={user._id} onClick={() => setSelectedUser(user)} tabIndex="0">
                  <td><strong>{user.name}</strong><span className="cell-subtitle">{user.email}</span></td>
                  <td>{user.history.length}</td>
                  <td>{user.wasteKg.toFixed(2)} kg</td>
                  <td>{user.earnedPoints}</td>
                  <td>{user.history[0] ? formatDate(user.history[0].createdAt) : 'No activity'}</td>
                </tr>
              ))}
              {userRows.length === 0 && <TableEmpty colSpan={5} text="No residents found." />}
            </tbody>
          </table>
        </div>
      </section>
      {selectedUser && (
        <Modal title={`${selectedUser.name}'s disposal history`} eyebrow={selectedUser.email} onClose={() => setSelectedUser(null)} wide>
          <DisposalTable disposals={selectedUser.history} />
        </Modal>
      )}
    </div>
  );
}

function AdminBinTools({ data, token, runAction, loading }) {
  const [createdKey, setCreatedKey] = useState('');
  const [levels, setLevels] = useState({});
  const [showAddModal, setShowAddModal] = useState(false);

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
    if (result) {
      event.currentTarget.reset();
      setShowAddModal(false);
    }
  }

  return (
    <div className="view-stack">
      <div className="list-toolbar">
        <div><p className="eyebrow">Maintenance</p><h3>Smart bins</h3></div>
        <button type="button" className="primary-button" onClick={() => setShowAddModal(true)}>+ Add bin</button>
      </div>

      {showAddModal && (
        <Modal title="Add a smart bin" eyebrow="New station" onClose={() => setShowAddModal(false)}>
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
        </Modal>
      )}

      {createdKey && (
        <section className="panel highlight-panel">
          <p className="eyebrow">Save or display this value</p>
          <code>{createdKey}</code>
        </section>
      )}

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">All stations</p>
            <h3>{data.bins.length} registered bins</h3>
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
                    <div className="bin-fill-control">
                      <div className="bin-fill-label">
                        <strong>{levels[bin._id] ?? bin.fillLevel ?? 0}%</strong>
                        <span className={(Number(levels[bin._id] ?? bin.fillLevel ?? 0) >= 100) ? 'capacity-full' : (Number(levels[bin._id] ?? bin.fillLevel ?? 0) >= 90 ? 'capacity-warning' : 'capacity-ok')}>
                          {Number(levels[bin._id] ?? bin.fillLevel ?? 0) >= 100 ? 'Full capacity' : Number(levels[bin._id] ?? bin.fillLevel ?? 0) >= 90 ? 'Almost full' : 'Available'}
                        </span>
                      </div>
                      <div className="bin-fill-meter"><i style={{ width: `${Math.min(100, Number(levels[bin._id] ?? bin.fillLevel ?? 0))}%` }} /></div>
                      <input
                        className="tiny-input"
                        type="number"
                        min="0"
                        max="100"
                        value={levels[bin._id] ?? bin.fillLevel ?? 0}
                        onChange={(event) => setLevels({ ...levels, [bin._id]: event.target.value })}
                        aria-label={`Fill level for ${bin.code}`}
                      />
                    </div>
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
  const [showAddModal, setShowAddModal] = useState(false);
  const [questTab, setQuestTab] = useState('current');
  const now = new Date();
  const currentQuests = quests.filter((quest) => quest.status !== 'closed' && new Date(quest.expiryDate) >= now);
  const historicalQuests = quests.filter((quest) => quest.status === 'closed' || new Date(quest.expiryDate) < now);

  async function createQuest(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const wasteType = form.get('wasteType');
    const targetCount = form.get('targetCount') ? Number(form.get('targetCount')) : null;
    const targetWeightKg = form.get('targetWeightKg') ? Number(form.get('targetWeightKg')) : null;
    if (!targetCount && !targetWeightKg) {
      const targetInput = event.currentTarget.querySelector('[name="targetCount"]');
      targetInput.setCustomValidity('Enter an item target or a weight target.');
      targetInput.reportValidity();
      targetInput.setCustomValidity('');
      return;
    }
    const result = await runAction(
      () => apiRequest('/api/quests', {
        method: 'POST',
        token,
        body: {
          title: form.get('title'),
          description: form.get('description'),
          wasteType: wasteType || null,
          targetCount,
          targetWeightKg,
          pointsReward: Number(form.get('pointsReward')),
          startDate: form.get('startDate'),
          expiryDate: form.get('expiryDate'),
          frequency: form.get('frequency'),
        },
      }),
      'Quest created'
    );
    if (result) {
      event.currentTarget.reset();
      setShowAddModal(false);
    }
  }

  return (
    <div className="view-stack">
      <div className="list-toolbar">
        <div><p className="eyebrow">Community goals</p><h3>Quest schedule</h3></div>
        <button type="button" className="primary-button" onClick={() => setShowAddModal(true)}>+ Add quest</button>
      </div>
      <div className="content-tabs" role="tablist" aria-label="Quest views">
        <button type="button" role="tab" aria-selected={questTab === 'current'} className={questTab === 'current' ? 'active' : ''} onClick={() => setQuestTab('current')}>
          Current <span>{currentQuests.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={questTab === 'history'} className={questTab === 'history' ? 'active' : ''} onClick={() => setQuestTab('history')}>
          History <span>{historicalQuests.length}</span>
        </button>
      </div>
      <QuestView quests={questTab === 'current' ? currentQuests : historicalQuests} session={null} admin history={questTab === 'history'} />
      {showAddModal && (
      <Modal title="Schedule a quest" eyebrow="New community goal" onClose={() => setShowAddModal(false)}>
      <AdminForm title="Quest details" eyebrow="Schedule" onSubmit={createQuest}>
        <label>Title<input name="title" placeholder="Plastic Patrol" required /></label>
        <label>Description<input name="description" placeholder="Collect clean plastic waste" /></label>
        <label>
          Waste type
          <select name="wasteType">
            <option value="">Any waste</option>
            {wasteTypes.map((type) => <option key={type}>{type}</option>)}
          </select>
        </label>
        <label>Item target <span>(optional)</span><input name="targetCount" type="number" min="1" placeholder="None" /></label>
        <label>Weight target in kg <span>(optional)</span><input name="targetWeightKg" type="number" min="0.001" step="0.001" placeholder="None" /></label>
        <label>Reward points<input name="pointsReward" type="number" min="0" defaultValue="50" required /></label>
        <label>Quest type<select name="frequency" defaultValue="daily"><option value="daily">Daily quest</option><option value="weekly">Weekly quest</option></select></label>
        <label>Starts<input name="startDate" type="datetime-local" required /></label>
        <label>Ends<input name="expiryDate" type="datetime-local" required /></label>
        <button className="primary-button" type="submit" disabled={loading}>Create quest</button>
      </AdminForm>
      </Modal>
      )}
    </div>
  );
}

function AdminRewardTools({ rewards, token, runAction, loading }) {
  const [showAddModal, setShowAddModal] = useState(false);

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
    if (result) {
      event.currentTarget.reset();
      setShowAddModal(false);
    }
  }

  return (
    <div className="view-stack">
      <div className="list-toolbar">
        <div><p className="eyebrow">Rewards catalog</p><h3>Available rewards</h3></div>
        <button type="button" className="primary-button" onClick={() => setShowAddModal(true)}>+ Add reward</button>
      </div>
      <AdminRewardCatalog rewards={rewards} />
      {showAddModal && (
      <Modal title="Add a reward" eyebrow="Catalog item" onClose={() => setShowAddModal(false)}>
      <AdminForm title="Add reward" eyebrow="Catalog" onSubmit={createReward}>
        <label>Name<input name="name" placeholder="Eco voucher" required /></label>
        <label>Description<input name="description" placeholder="Redeem at the admin booth" /></label>
        <label>Points cost<input name="pointsCost" type="number" min="0" defaultValue="100" required /></label>
        <label>Stock<input name="stock" type="number" min="0" defaultValue="10" required /></label>
        <button className="primary-button" type="submit" disabled={loading}>Create reward</button>
      </AdminForm>
      </Modal>
      )}
      <AdminRedemptions rewards={rewards} token={token} runAction={runAction} />
    </div>
  );
}

function AdminRewardCatalog({ rewards }) {
  return (
    <section className="panel">
      <div className="table-wrap">
        <table>
          <thead><tr><th>Reward</th><th>Description</th><th>Cost</th><th>Stock</th><th>Status</th></tr></thead>
          <tbody>
            {rewards.map((reward) => (
              <tr key={reward._id}>
                <td><strong>{reward.name}</strong></td>
                <td>{reward.description || '—'}</td>
                <td>{reward.pointsCost} pts</td>
                <td>{reward.stock}</td>
                <td><span className={reward.status === 'active' ? 'badge success' : 'badge'}>{reward.status}</span></td>
              </tr>
            ))}
            {rewards.length === 0 && <TableEmpty colSpan={5} text="No rewards found." />}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function QuestView({ quests, session, admin = false, history = false }) {
  const [residentQuestTab, setResidentQuestTab] = useState('current');
  const residentQuestRows = quests.map((quest) => {
    const participant = quest.participants?.find((entry) => {
      const participantId = entry.user?._id || entry.user;
      return participantId?.toString() === session?._id?.toString();
    });
    return { quest, participant };
  });
  const residentCurrentQuests = residentQuestRows.filter(({ participant }) => !participant?.completed).map(({ quest }) => quest);
  const residentCompletedQuests = residentQuestRows.filter(({ participant }) => participant?.completed).map(({ quest }) => quest);
  const visibleQuests = admin
    ? quests
    : residentQuestTab === 'completed' ? residentCompletedQuests : residentCurrentQuests;

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Community goals</p>
          <h3>{admin ? (history ? 'Quest history' : 'Current quests') : 'Available quests'}</h3>
        </div>
      </div>
      {!admin && (
        <div className="content-tabs resident-quest-tabs" role="tablist" aria-label="Quest views">
          <button type="button" role="tab" aria-selected={residentQuestTab === 'current'} className={residentQuestTab === 'current' ? 'active' : ''} onClick={() => setResidentQuestTab('current')}>
            Current <span>{residentCurrentQuests.length}</span>
          </button>
          <button type="button" role="tab" aria-selected={residentQuestTab === 'completed'} className={residentQuestTab === 'completed' ? 'active' : ''} onClick={() => setResidentQuestTab('completed')}>
            Completed <span>{residentCompletedQuests.length}</span>
          </button>
        </div>
      )}
      <div className="item-grid">
        {visibleQuests.length === 0 && <EmptyState text={history ? 'No expired or closed quests yet.' : !admin && residentQuestTab === 'completed' ? 'No completed quests yet.' : 'No quests are available right now.'} />}
        {visibleQuests.map((quest) => {
          const participantCount = quest.participantCount ?? quest.participants?.length ?? 0;
          const userProgress = quest.participants?.find((participant) => {
            const participantId = participant.user?._id || participant.user;
            return participantId?.toString() === session?._id?.toString();
          });
          const progress = userProgress?.progress || 0;
          const weightProgress = userProgress?.weightProgressKg || 0;
          const countPercent = quest.targetCount ? Math.min(100, Math.round((progress / quest.targetCount) * 100)) : 100;
          const weightPercent = quest.targetWeightKg ? Math.min(100, Math.round((weightProgress / quest.targetWeightKg) * 100)) : 100;
          const progressPercent = Math.min(countPercent, weightPercent);
          const isScheduled = quest.startDate && new Date(quest.startDate) > new Date();
          const isExpired = new Date(quest.expiryDate) < new Date();

          return (
            <article className="item-card" key={quest._id}>
              <div>
                <span className="badge">{quest.frequency || 'daily'}</span>{' '}
                <span className="badge">{isExpired ? 'expired' : isScheduled ? 'scheduled' : quest.status}</span>{' '}
                <span className="badge">{quest.wasteType || 'Any waste'}</span>
                <h4>{quest.title}</h4>
                <p>{quest.description || 'Complete the target before the expiry date.'}</p>
              </div>
              <dl>
                <div><dt>Item target</dt><dd>{quest.targetCount || 'None'}</dd></div>
                <div><dt>Weight target</dt><dd>{quest.targetWeightKg ? `${quest.targetWeightKg} kg` : 'None'}</dd></div>
                <div><dt>Reward</dt><dd>{quest.pointsReward} pts</dd></div>
                <div><dt>{admin ? 'Tracked' : 'Items'}</dt><dd>{admin ? participantCount : quest.targetCount ? `${progress}/${quest.targetCount}` : 'Not required'}</dd></div>
                {!admin && <div><dt>Weight</dt><dd>{quest.targetWeightKg ? `${weightProgress.toFixed(2)}/${quest.targetWeightKg} kg` : 'Not required'}</dd></div>}
                {admin && <div><dt>Starts</dt><dd>{formatDate(quest.startDate)}</dd></div>}
                {admin && <div><dt>Ends</dt><dd>{formatDate(quest.expiryDate)}</dd></div>}
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
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState({ key: 'name', direction: 'asc' });
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const filteredUsers = useMemo(() => {
    const query = search.trim().toLowerCase();
    return users
      .filter((user) => !query || `${user.name} ${user.email} ${user.status}`.toLowerCase().includes(query))
      .sort((a, b) => {
        const left = sort.key === 'points' ? Number(a.points || 0) : String(a[sort.key] || '').toLowerCase();
        const right = sort.key === 'points' ? Number(b.points || 0) : String(b[sort.key] || '').toLowerCase();
        const result = left < right ? -1 : left > right ? 1 : 0;
        return sort.direction === 'asc' ? result : -result;
      });
  }, [users, search, sort]);
  const totalPages = Math.max(1, Math.ceil(filteredUsers.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const visibleUsers = filteredUsers.slice((safePage - 1) * pageSize, safePage * pageSize);

  function changeSort(key) {
    setSort((current) => ({ key, direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc' }));
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Residents</p>
          <h3>User directory</h3>
        </div>
        <div className="directory-tools">
          <input
            type="search"
            value={search}
            onChange={(event) => { setSearch(event.target.value); setPage(1); }}
            placeholder="Search name, email, or status…"
            aria-label="Search users"
          />
          <span>{filteredUsers.length} users</span>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th><button className="sort-button" type="button" onClick={() => changeSort('name')}>Name {sort.key === 'name' ? (sort.direction === 'asc' ? '↑' : '↓') : ''}</button></th>
              <th><button className="sort-button" type="button" onClick={() => changeSort('email')}>Email {sort.key === 'email' ? (sort.direction === 'asc' ? '↑' : '↓') : ''}</button></th>
              <th><button className="sort-button" type="button" onClick={() => changeSort('points')}>Points {sort.key === 'points' ? (sort.direction === 'asc' ? '↑' : '↓') : ''}</button></th>
              <th><button className="sort-button" type="button" onClick={() => changeSort('status')}>Status {sort.key === 'status' ? (sort.direction === 'asc' ? '↑' : '↓') : ''}</button></th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visibleUsers.map((user) => (
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
            {visibleUsers.length === 0 && <TableEmpty colSpan={5} text="No users match your search." />}
          </tbody>
        </table>
      </div>
      <div className="pagination">
        <button type="button" className="secondary-button small" disabled={safePage === 1} onClick={() => setPage(safePage - 1)}>Previous</button>
        <span>Page {safePage} of {totalPages}</span>
        <button type="button" className="secondary-button small" disabled={safePage === totalPages} onClick={() => setPage(safePage + 1)}>Next</button>
      </div>
    </section>
  );
}

function Modal({ title, eyebrow, onClose, children, wide = false }) {
  useEffect(() => {
    function closeOnEscape(event) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`modal-card ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <div><p className="eyebrow">{eyebrow}</p><h3>{title}</h3></div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close dialog">×</button>
        </header>
        {children}
      </section>
    </div>
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
