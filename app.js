/* =========================================
   SHARMUTOCOIN - Prediction Market App
   ========================================= */

const STARTING_BALANCE = 200;
const CURRENCY = 'SHC';

// ── Avatar colors ──
const AVATAR_COLORS = [
    '#7c3aed', '#3b82f6', '#00d26a', '#ef4444', '#f59e0b',
    '#ec4899', '#06b6d4', '#8b5cf6', '#10b981', '#f97316',
];

function getAvatarColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

// ── Data Store ──
const Store = {
    _data: null,

    _default() {
        return {
            players: {},   // { name: { balance, joinedAt } }
            markets: [],   // array of market objects
            bets: [],      // array of bet objects
        };
    },

    load() {
        try {
            const raw = localStorage.getItem('sharmutocoin_data');
            this._data = raw ? JSON.parse(raw) : this._default();
        } catch {
            this._data = this._default();
        }
        return this._data;
    },

    save() {
        localStorage.setItem('sharmutocoin_data', JSON.stringify(this._data));
    },

    get data() {
        if (!this._data) this.load();
        return this._data;
    },

    // Players
    getPlayer(name) {
        return this.data.players[name] || null;
    },

    createPlayer(name) {
        if (!this.data.players[name]) {
            this.data.players[name] = {
                balance: STARTING_BALANCE,
                joinedAt: Date.now(),
            };
            this.save();
        }
        return this.data.players[name];
    },

    updateBalance(name, delta) {
        if (this.data.players[name]) {
            this.data.players[name].balance += delta;
            this.save();
        }
    },

    getAllPlayers() {
        return Object.entries(this.data.players).map(([name, data]) => ({
            name,
            ...data,
        }));
    },

    // Markets
    createMarket({ question, category, description, endDate, initialOdds, createdBy }) {
        const market = {
            id: 'mkt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            question,
            category,
            description: description || '',
            endDate,
            createdBy,
            createdAt: Date.now(),
            resolved: false,
            resolution: null, // 'yes' or 'no'
            yesPool: initialOdds,
            noPool: 100 - initialOdds,
            oddsHistory: [
                { time: Date.now(), yes: initialOdds }
            ],
            volume: 0,
        };
        this.data.markets.push(market);
        this.save();
        return market;
    },

    getMarket(id) {
        return this.data.markets.find(m => m.id === id) || null;
    },

    getAllMarkets() {
        return [...this.data.markets].sort((a, b) => b.createdAt - a.createdAt);
    },

    resolveMarket(id, resolution) {
        const market = this.getMarket(id);
        if (!market || market.resolved) return;

        market.resolved = true;
        market.resolution = resolution;
        market.resolvedAt = Date.now();

        // Pay out winners
        const marketBets = this.data.bets.filter(b => b.marketId === id);
        for (const bet of marketBets) {
            if (bet.side === resolution) {
                // Winner: pay based on odds at time of bet
                const payout = bet.potentialWin;
                this.updateBalance(bet.player, payout);
                bet.result = 'won';
                bet.payout = payout;
            } else {
                bet.result = 'lost';
                bet.payout = 0;
            }
        }

        this.save();
        return market;
    },

    // Bets
    placeBet(marketId, player, side, amount) {
        const market = this.getMarket(marketId);
        if (!market || market.resolved) return null;

        const playerData = this.getPlayer(player);
        if (!playerData || playerData.balance < amount) return null;

        // Calculate odds
        const totalPool = market.yesPool + market.noPool;
        const yesProb = market.yesPool / totalPool;
        const noProb = market.noPool / totalPool;

        let potentialWin;
        if (side === 'yes') {
            potentialWin = Math.round(amount / yesProb * 100) / 100;
            // Shift odds: more yes bets -> yes becomes more likely
            market.yesPool += amount * 0.7;
            market.noPool = Math.max(1, market.noPool - amount * 0.15);
        } else {
            potentialWin = Math.round(amount / noProb * 100) / 100;
            market.noPool += amount * 0.7;
            market.yesPool = Math.max(1, market.yesPool - amount * 0.15);
        }

        // Deduct balance
        this.updateBalance(player, -amount);

        // Record odds change
        const newTotal = market.yesPool + market.noPool;
        market.oddsHistory.push({
            time: Date.now(),
            yes: Math.round(market.yesPool / newTotal * 100),
        });

        market.volume += amount;

        const bet = {
            id: 'bet_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            marketId,
            player,
            side,
            amount,
            potentialWin,
            oddsAtTime: side === 'yes' ? Math.round(yesProb * 100) : Math.round(noProb * 100),
            placedAt: Date.now(),
            result: 'pending',
            payout: 0,
        };

        this.data.bets.push(bet);
        this.save();
        return bet;
    },

    getBetsForMarket(marketId) {
        return this.data.bets.filter(b => b.marketId === marketId)
            .sort((a, b) => b.placedAt - a.placedAt);
    },

    getBetsForPlayer(player) {
        return this.data.bets.filter(b => b.player === player)
            .sort((a, b) => b.placedAt - a.placedAt);
    },

    getMarketOdds(marketId) {
        const market = this.getMarket(marketId);
        if (!market) return { yes: 50, no: 50 };
        const total = market.yesPool + market.noPool;
        return {
            yes: Math.round(market.yesPool / total * 100),
            no: Math.round(market.noPool / total * 100),
        };
    },
};

// ── App State ──
let currentUser = null;
let currentMarketId = null;
let betSide = 'yes';
let oddsChart = null;
let miniCharts = {};

// ── DOM refs ──
const $ = id => document.getElementById(id);

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
    Store.load();

    // Check if user is already logged in
    const saved = sessionStorage.getItem('sharmutocoin_user');
    if (saved) {
        currentUser = saved;
        Store.createPlayer(currentUser); // ensure player exists
        showApp();
    } else {
        showLogin();
    }

    setupEventListeners();
});

function setupEventListeners() {
    // Login
    $('join-btn').addEventListener('click', handleLogin);
    $('player-name').addEventListener('keydown', e => {
        if (e.key === 'Enter') handleLogin();
    });

    // Tabs
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    // Filter pills
    document.querySelectorAll('.pill').forEach(pill => {
        pill.addEventListener('click', () => {
            document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            renderMarkets(pill.dataset.filter);
        });
    });

    // Create market form
    $('create-market-form').addEventListener('submit', handleCreateMarket);
    $('market-initial-odds').addEventListener('input', e => {
        $('odds-display').textContent = e.target.value + '%';
    });

    // Modal
    $('modal-close').addEventListener('click', closeModal);
    $('market-modal').addEventListener('click', e => {
        if (e.target === $('market-modal')) closeModal();
    });

    // Bet side toggle
    $('bet-yes-btn').addEventListener('click', () => setBetSide('yes'));
    $('bet-no-btn').addEventListener('click', () => setBetSide('no'));

    // Quick amounts
    document.querySelectorAll('.quick-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const val = btn.dataset.amount;
            if (val === 'max') {
                const player = Store.getPlayer(currentUser);
                $('bet-amount').value = player ? player.balance : 0;
            } else {
                $('bet-amount').value = val;
            }
            updatePotentialWin();
        });
    });

    $('bet-amount').addEventListener('input', updatePotentialWin);

    // Place bet
    $('place-bet-btn').addEventListener('click', handlePlaceBet);

    // Resolve
    $('resolve-yes-btn').addEventListener('click', () => handleResolve('yes'));
    $('resolve-no-btn').addEventListener('click', () => handleResolve('no'));

    // Set default end date to 30 days from now
    const defaultEnd = new Date();
    defaultEnd.setDate(defaultEnd.getDate() + 30);
    $('market-end-date').value = defaultEnd.toISOString().split('T')[0];
}

// ── Login ──
function handleLogin() {
    const name = $('player-name').value.trim();
    if (!name) {
        toast('Enter your name!', 'error');
        return;
    }

    currentUser = name;
    Store.createPlayer(name);
    sessionStorage.setItem('sharmutocoin_user', name);
    showApp();
    toast(`Welcome, ${name}! You have ${STARTING_BALANCE} ${CURRENCY}`, 'success');
}

function showLogin() {
    $('login-screen').classList.add('active');
    $('app-screen').classList.remove('active');
    renderPlayersPreview();
}

function showApp() {
    $('login-screen').classList.remove('active');
    $('app-screen').classList.add('active');

    const player = Store.getPlayer(currentUser);
    $('user-name-display').textContent = currentUser;
    $('user-avatar').textContent = currentUser[0].toUpperCase();
    $('user-avatar').style.background = getAvatarColor(currentUser);
    updateBalanceDisplay();
    renderScoreboard();

    renderMarkets('all');
    switchTab('markets');
}

function updateBalanceDisplay() {
    const player = Store.getPlayer(currentUser);
    if (player) {
        $('user-balance').textContent = `${Math.round(player.balance)} ${CURRENCY}`;
    }
}

// ── Scoreboard ──
function renderScoreboard() {
    const players = Store.getAllPlayers().sort((a, b) => b.balance - a.balance);
    const bar = $('scoreboard-bar');

    if (players.length === 0) {
        bar.innerHTML = '';
        return;
    }

    const medals = ['\u{1F451}', '\u{1F948}', '\u{1F949}'];

    bar.innerHTML = `
        <span class="scoreboard-title">Scoreboard</span>
        ${players.map((p, i) => {
            const isMe = p.name === currentUser;
            const rankClass = i < 3 ? `rank-${i + 1}` : '';
            const meClass = isMe ? 'is-me' : '';
            const medal = i < 3 ? `<span class="scoreboard-rank-badge">${medals[i]}</span>` : '';

            return `
                <div class="scoreboard-player ${rankClass} ${meClass}">
                    ${medal}
                    <span class="scoreboard-avatar" style="background: ${getAvatarColor(p.name)}">${p.name[0].toUpperCase()}</span>
                    <span class="scoreboard-name">${escapeHtml(p.name)}</span>
                    <span class="scoreboard-balance">${Math.round(p.balance)} ${CURRENCY}</span>
                </div>
            `;
        }).join('')}
    `;
}

// ── Tabs ──
function switchTab(tabName) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

    document.querySelector(`.tab[data-tab="${tabName}"]`).classList.add('active');
    document.getElementById(`tab-${tabName}`).classList.add('active');

    if (tabName === 'markets') renderMarkets();
    if (tabName === 'leaderboard') renderLeaderboard();
    if (tabName === 'my-bets') renderMyBets();
}

// ── Players Preview (Login Screen) ──
function renderPlayersPreview() {
    const players = Store.getAllPlayers();
    const container = $('players-list-preview');
    if (players.length === 0) {
        container.innerHTML = '<p style="color: var(--text-muted); font-size: 14px;">No players yet. Be the first!</p>';
        return;
    }
    container.innerHTML = players.map(p => `
        <div class="player-chip">
            <span class="chip-avatar" style="background: ${getAvatarColor(p.name)}">${p.name[0].toUpperCase()}</span>
            <span>${p.name}</span>
            <span style="color: var(--gold); font-weight: 600;">${Math.round(p.balance)}</span>
        </div>
    `).join('');
}

// ── Markets ──
function renderMarkets(filter) {
    if (!filter) {
        const activePill = document.querySelector('.pill.active');
        filter = activePill ? activePill.dataset.filter : 'all';
    }

    let markets = Store.getAllMarkets();
    if (filter !== 'all') {
        markets = markets.filter(m => m.category === filter);
    }

    const grid = $('markets-grid');
    if (markets.length === 0) {
        grid.innerHTML = `
            <div class="no-markets" style="grid-column: 1 / -1;">
                <h3>No markets yet</h3>
                <p>Create a market to get started!</p>
            </div>
        `;
        return;
    }

    grid.innerHTML = markets.map(m => {
        const odds = Store.getMarketOdds(m.id);
        const canvasId = `mini-chart-${m.id}`;
        let badge = '';
        if (m.resolved) {
            badge = m.resolution === 'yes'
                ? '<span class="market-card-badge badge-resolved-yes">Resolved YES</span>'
                : '<span class="market-card-badge badge-resolved-no">Resolved NO</span>';
        }

        return `
            <div class="market-card ${m.resolved ? 'resolved' : ''}" data-market-id="${m.id}">
                <span class="market-card-category ${m.category}">${m.category}</span>
                <div class="market-card-title">${escapeHtml(m.question)}</div>
                <div class="market-card-chart">
                    <canvas id="${canvasId}"></canvas>
                </div>
                <div class="market-card-odds">
                    <div class="card-odds-pill yes">Yes ${odds.yes}%</div>
                    <div class="card-odds-pill no">No ${odds.no}%</div>
                </div>
                <div class="market-card-footer">
                    <span class="market-card-volume">${Math.round(m.volume)} ${CURRENCY} volume</span>
                    ${badge || `<span>${formatDate(m.endDate)}</span>`}
                </div>
            </div>
        `;
    }).join('');

    // Attach click handlers
    grid.querySelectorAll('.market-card').forEach(card => {
        card.addEventListener('click', () => openMarket(card.dataset.marketId));
    });

    // Render mini charts after DOM update
    requestAnimationFrame(() => {
        markets.forEach(m => renderMiniChart(m));
    });
}

function renderMiniChart(market) {
    const canvasId = `mini-chart-${market.id}`;
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    // Destroy existing chart
    if (miniCharts[market.id]) {
        miniCharts[market.id].destroy();
    }

    const history = market.oddsHistory;
    const labels = history.map((_, i) => i);
    const data = history.map(h => h.yes);

    // Add current point if only 1 data point
    if (data.length === 1) {
        labels.push(1);
        data.push(data[0]);
    }

    const gradient = ctx.createLinearGradient(0, 0, 0, 80);
    gradient.addColorStop(0, 'rgba(124, 58, 237, 0.3)');
    gradient.addColorStop(1, 'rgba(124, 58, 237, 0)');

    miniCharts[market.id] = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                data,
                borderColor: '#7c3aed',
                backgroundColor: gradient,
                borderWidth: 2,
                fill: true,
                tension: 0.4,
                pointRadius: 0,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales: {
                x: { display: false },
                y: { display: false, min: 0, max: 100 },
            },
            interaction: { enabled: false },
            animation: { duration: 600 },
        },
    });
}

// ── Market Modal ──
function openMarket(marketId) {
    currentMarketId = marketId;
    const market = Store.getMarket(marketId);
    if (!market) return;

    const odds = Store.getMarketOdds(marketId);

    // Set category style
    const categoryEl = $('modal-category');
    categoryEl.textContent = market.category.toUpperCase();
    categoryEl.className = `modal-category`;

    $('modal-title').textContent = market.question;
    $('modal-description').textContent = market.description || '';
    $('modal-volume').textContent = `Volume: ${Math.round(market.volume)} ${CURRENCY}`;
    $('modal-closing').textContent = `Closes: ${formatDate(market.endDate)}`;

    $('modal-yes-odds').textContent = `${odds.yes}%`;
    $('modal-no-odds').textContent = `${odds.no}%`;
    $('modal-yes-payout').textContent = `Win ${(100 / odds.yes).toFixed(2)}x`;
    $('modal-no-payout').textContent = `Win ${(100 / odds.no).toFixed(2)}x`;

    // Render chart
    renderOddsChart(market);

    // Render recent bets
    renderModalBets(marketId);

    // Show/hide resolve section (creator can resolve)
    const resolveSection = $('modal-resolve-section');
    if (market.createdBy === currentUser && !market.resolved) {
        resolveSection.style.display = 'block';
    } else {
        resolveSection.style.display = 'none';
    }

    // Show/hide bet section
    const betSection = document.querySelector('.bet-section');
    if (market.resolved) {
        betSection.style.display = 'none';
    } else {
        betSection.style.display = 'block';
    }

    // Reset bet form
    betSide = 'yes';
    $('bet-yes-btn').classList.add('active');
    $('bet-no-btn').classList.remove('active');
    $('bet-amount').value = '';
    $('potential-win-amount').textContent = `0 ${CURRENCY}`;

    $('market-modal').classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeModal() {
    $('market-modal').classList.remove('active');
    document.body.style.overflow = '';
    currentMarketId = null;
}

function renderOddsChart(market) {
    const canvas = $('odds-chart');
    const ctx = canvas.getContext('2d');

    if (oddsChart) {
        oddsChart.destroy();
    }

    const history = market.oddsHistory;

    // Build time labels
    const labels = history.map(h => {
        const d = new Date(h.time);
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
            ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    });

    const yesData = history.map(h => h.yes);
    const noData = history.map(h => 100 - h.yes);

    // If only 1 data point, duplicate it
    if (labels.length === 1) {
        labels.push(labels[0]);
        yesData.push(yesData[0]);
        noData.push(noData[0]);
    }

    const greenGrad = ctx.createLinearGradient(0, 0, 0, 200);
    greenGrad.addColorStop(0, 'rgba(0, 210, 106, 0.25)');
    greenGrad.addColorStop(1, 'rgba(0, 210, 106, 0)');

    const redGrad = ctx.createLinearGradient(0, 0, 0, 200);
    redGrad.addColorStop(0, 'rgba(255, 71, 87, 0.15)');
    redGrad.addColorStop(1, 'rgba(255, 71, 87, 0)');

    oddsChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'YES %',
                    data: yesData,
                    borderColor: '#00d26a',
                    backgroundColor: greenGrad,
                    borderWidth: 2.5,
                    fill: true,
                    tension: 0.4,
                    pointRadius: yesData.length <= 10 ? 4 : 0,
                    pointBackgroundColor: '#00d26a',
                },
                {
                    label: 'NO %',
                    data: noData,
                    borderColor: '#ff4757',
                    backgroundColor: redGrad,
                    borderWidth: 2.5,
                    fill: true,
                    tension: 0.4,
                    pointRadius: noData.length <= 10 ? 4 : 0,
                    pointBackgroundColor: '#ff4757',
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        color: '#8b949e',
                        font: { family: 'Inter', size: 12, weight: '600' },
                        usePointStyle: true,
                        pointStyle: 'circle',
                        padding: 16,
                    },
                },
                tooltip: {
                    backgroundColor: '#1c2128',
                    borderColor: '#30363d',
                    borderWidth: 1,
                    titleColor: '#f0f6fc',
                    bodyColor: '#8b949e',
                    padding: 12,
                    cornerRadius: 8,
                    titleFont: { family: 'Inter', weight: '600' },
                    bodyFont: { family: 'Inter' },
                    callbacks: {
                        label: ctx => `${ctx.dataset.label}: ${ctx.raw}%`,
                    },
                },
            },
            scales: {
                x: {
                    display: true,
                    grid: { color: 'rgba(48, 54, 61, 0.5)' },
                    ticks: {
                        color: '#6e7681',
                        font: { family: 'Inter', size: 11 },
                        maxTicksLimit: 6,
                    },
                },
                y: {
                    display: true,
                    min: 0,
                    max: 100,
                    grid: { color: 'rgba(48, 54, 61, 0.5)' },
                    ticks: {
                        color: '#6e7681',
                        font: { family: 'Inter', size: 11 },
                        callback: v => v + '%',
                        stepSize: 25,
                    },
                },
            },
            animation: { duration: 800 },
        },
    });
}

function renderModalBets(marketId) {
    const bets = Store.getBetsForMarket(marketId);
    const container = $('modal-bets-list');

    if (bets.length === 0) {
        container.innerHTML = '<p class="no-history">No bets yet. Be the first!</p>';
        return;
    }

    container.innerHTML = bets.slice(0, 20).map(b => `
        <div class="history-bet">
            <div class="history-bet-player">
                <span class="history-bet-avatar" style="background: ${getAvatarColor(b.player)}">${b.player[0].toUpperCase()}</span>
                <span>${escapeHtml(b.player)}</span>
                <span class="history-bet-side ${b.side}">${b.side.toUpperCase()}</span>
            </div>
            <span class="history-bet-amount">${b.amount} ${CURRENCY}</span>
        </div>
    `).join('');
}

// ── Betting ──
function setBetSide(side) {
    betSide = side;
    $('bet-yes-btn').classList.toggle('active', side === 'yes');
    $('bet-no-btn').classList.toggle('active', side === 'no');
    updatePotentialWin();
}

function updatePotentialWin() {
    if (!currentMarketId) return;
    const amount = parseFloat($('bet-amount').value) || 0;
    const odds = Store.getMarketOdds(currentMarketId);
    const prob = betSide === 'yes' ? odds.yes : odds.no;
    const win = prob > 0 ? Math.round(amount / (prob / 100) * 100) / 100 : 0;
    $('potential-win-amount').textContent = `${win.toFixed(1)} ${CURRENCY}`;
}

function handlePlaceBet() {
    if (!currentMarketId || !currentUser) return;

    const amount = parseInt($('bet-amount').value);
    if (!amount || amount < 1) {
        toast('Enter a valid amount!', 'error');
        return;
    }

    const player = Store.getPlayer(currentUser);
    if (player.balance < amount) {
        toast(`Not enough ${CURRENCY}! You have ${Math.round(player.balance)}`, 'error');
        return;
    }

    const bet = Store.placeBet(currentMarketId, currentUser, betSide, amount);
    if (!bet) {
        toast('Could not place bet!', 'error');
        return;
    }

    toast(`Bet placed! ${amount} ${CURRENCY} on ${betSide.toUpperCase()}`, 'success');

    // Refresh modal
    updateBalanceDisplay();
    renderScoreboard();
    openMarket(currentMarketId);
}

// ── Resolve Market ──
function handleResolve(resolution) {
    if (!currentMarketId) return;

    const market = Store.getMarket(currentMarketId);
    if (!market) return;

    const confirmed = confirm(`Are you sure you want to resolve this market as ${resolution.toUpperCase()}?\n\nThis will pay out all winning bets.`);
    if (!confirmed) return;

    Store.resolveMarket(currentMarketId, resolution);
    toast(`Market resolved as ${resolution.toUpperCase()}!`, 'success');

    updateBalanceDisplay();
    renderScoreboard();
    closeModal();
    renderMarkets();
}

// ── Create Market ──
function handleCreateMarket(e) {
    e.preventDefault();

    const question = $('market-question').value.trim();
    const category = $('market-category').value;
    const description = $('market-description').value.trim();
    const endDate = $('market-end-date').value;
    const initialOdds = parseInt($('market-initial-odds').value);

    if (!question) {
        toast('Enter a question!', 'error');
        return;
    }
    if (!endDate) {
        toast('Pick a closing date!', 'error');
        return;
    }

    Store.createMarket({
        question,
        category,
        description,
        endDate,
        initialOdds,
        createdBy: currentUser,
    });

    toast('Market created!', 'success');

    // Reset form
    $('market-question').value = '';
    $('market-description').value = '';
    $('market-initial-odds').value = 50;
    $('odds-display').textContent = '50%';

    switchTab('markets');
}

// ── Leaderboard ──
function renderLeaderboard() {
    const players = Store.getAllPlayers()
        .sort((a, b) => b.balance - a.balance);

    const container = $('leaderboard-list');

    if (players.length === 0) {
        container.innerHTML = '<p class="no-bets">No players yet.</p>';
        return;
    }

    container.innerHTML = players.map((p, i) => {
        const rankClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
        const rankDisplay = i < 3 ? ['&#x1F451;', '&#x1F948;', '&#x1F949;'][i] : i + 1;
        const isMe = p.name === currentUser;

        return `
            <div class="leaderboard-row" style="${isMe ? 'border-color: var(--accent); background: rgba(124,58,237,0.05);' : ''}">
                <span class="leaderboard-rank ${rankClass}">${rankDisplay}</span>
                <span class="leaderboard-avatar" style="background: ${getAvatarColor(p.name)}">${p.name[0].toUpperCase()}</span>
                <span class="leaderboard-name">${escapeHtml(p.name)} ${isMe ? '(you)' : ''}</span>
                <span class="leaderboard-balance">${Math.round(p.balance)} ${CURRENCY}</span>
            </div>
        `;
    }).join('');
}

// ── My Bets ──
function renderMyBets() {
    const bets = Store.getBetsForPlayer(currentUser);
    const container = $('bets-list');

    if (bets.length === 0) {
        container.innerHTML = `
            <div class="no-bets">
                <p>You haven't placed any bets yet.</p>
                <p>Check out the markets and make your predictions!</p>
            </div>
        `;
        return;
    }

    container.innerHTML = bets.map(b => {
        const market = Store.getMarket(b.marketId);
        const question = market ? market.question : 'Unknown market';

        let resultHtml = '';
        if (b.result === 'won') {
            resultHtml = `<span class="bet-row-result won">Won +${Math.round(b.payout)} ${CURRENCY}</span>`;
        } else if (b.result === 'lost') {
            resultHtml = `<span class="bet-row-result lost">Lost</span>`;
        } else {
            resultHtml = `<span class="bet-row-result pending">Pending</span>`;
        }

        return `
            <div class="bet-row" data-market-id="${b.marketId}">
                <div class="bet-row-left">
                    <div class="bet-row-question">${escapeHtml(question)}</div>
                    <div class="bet-row-detail">${new Date(b.placedAt).toLocaleDateString()} &middot; Potential win: ${Math.round(b.potentialWin)} ${CURRENCY}</div>
                </div>
                <div class="bet-row-right">
                    <span class="bet-row-side ${b.side}">${b.side.toUpperCase()}</span>
                    <div class="bet-row-amount">${b.amount} ${CURRENCY}</div>
                    ${resultHtml}
                </div>
            </div>
        `;
    }).join('');

    // Click to open market
    container.querySelectorAll('.bet-row').forEach(row => {
        row.addEventListener('click', () => {
            const mId = row.dataset.marketId;
            if (Store.getMarket(mId)) openMarket(mId);
        });
    });
}

// ── Utilities ──
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatDate(dateStr) {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function toast(message, type = 'info') {
    const container = $('toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
        el.remove();
    }, 3000);
}
