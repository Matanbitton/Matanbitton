const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const STARTING_BALANCE = 10000;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// ── In-Memory Game State ──
const gameState = {
    players: {},   // { name: { balance, joinedAt } }
    markets: [],
    bets: [],
};

// ── Helper Functions (ported from client Store) ──

function getPlayer(name) {
    return gameState.players[name] || null;
}

function createPlayer(name) {
    if (!gameState.players[name]) {
        gameState.players[name] = {
            balance: STARTING_BALANCE,
            joinedAt: Date.now(),
        };
    }
    return gameState.players[name];
}

function updateBalance(name, delta) {
    if (gameState.players[name]) {
        gameState.players[name].balance += delta;
    }
}

function getAllPlayers() {
    return Object.entries(gameState.players).map(([name, data]) => ({
        name,
        ...data,
    }));
}

function createMarket({ question, category, description, endDate, initialOdds, createdBy }) {
    const market = {
        id: 'mkt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        question,
        category,
        description: description || '',
        endDate,
        createdBy,
        createdAt: Date.now(),
        resolved: false,
        resolution: null,
        yesPool: initialOdds,
        noPool: 100 - initialOdds,
        oddsHistory: [{ time: Date.now(), yes: initialOdds }],
        volume: 0,
    };
    gameState.markets.push(market);
    return market;
}

function getMarket(id) {
    return gameState.markets.find(m => m.id === id) || null;
}

function getAllMarkets() {
    return [...gameState.markets].sort((a, b) => b.createdAt - a.createdAt);
}

function getMarketOdds(id) {
    const market = getMarket(id);
    if (!market) return { yes: 50, no: 50 };
    const total = market.yesPool + market.noPool;
    return {
        yes: Math.round(market.yesPool / total * 100),
        no: Math.round(market.noPool / total * 100),
    };
}

function placeBet(marketId, player, side, amount) {
    const market = getMarket(marketId);
    if (!market || market.resolved) return null;

    const playerData = getPlayer(player);
    if (!playerData || playerData.balance < amount) return null;
    if (amount < 1) return null;

    const totalPool = market.yesPool + market.noPool;
    const yesProb = market.yesPool / totalPool;
    const noProb = market.noPool / totalPool;

    let potentialWin;
    if (side === 'yes') {
        potentialWin = Math.round(amount / yesProb * 100) / 100;
        market.yesPool += amount * 0.7;
        market.noPool = Math.max(1, market.noPool - amount * 0.15);
    } else {
        potentialWin = Math.round(amount / noProb * 100) / 100;
        market.noPool += amount * 0.7;
        market.yesPool = Math.max(1, market.yesPool - amount * 0.15);
    }

    updateBalance(player, -amount);

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

    gameState.bets.push(bet);
    return bet;
}

function resolveMarket(id, resolution) {
    const market = getMarket(id);
    if (!market || market.resolved) return null;

    market.resolved = true;
    market.resolution = resolution;
    market.resolvedAt = Date.now();

    const marketBets = gameState.bets.filter(b => b.marketId === id);
    for (const bet of marketBets) {
        if (bet.side === resolution) {
            const payout = bet.potentialWin;
            updateBalance(bet.player, payout);
            bet.result = 'won';
            bet.payout = payout;
        } else {
            bet.result = 'lost';
            bet.payout = 0;
        }
    }

    return market;
}

function getBetsForMarket(marketId) {
    return gameState.bets.filter(b => b.marketId === marketId)
        .sort((a, b) => b.placedAt - a.placedAt);
}

// ── Socket.io Connection Handler ──

io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    socket.on('join', ({ name }) => {
        if (!name || typeof name !== 'string') {
            socket.emit('error', { message: 'Invalid name' });
            return;
        }

        const trimmed = name.trim().slice(0, 20);
        if (!trimmed) {
            socket.emit('error', { message: 'Name cannot be empty' });
            return;
        }

        const player = createPlayer(trimmed);

        // Send full state to this client
        socket.emit('joinedOk', {
            player: { name: trimmed, ...player },
            allPlayers: getAllPlayers(),
            allMarkets: getAllMarkets(),
            allBets: gameState.bets,
        });

        // Tell everyone else
        socket.broadcast.emit('playerJoined', {
            player: { name: trimmed, ...player },
            allPlayers: getAllPlayers(),
        });
    });

    socket.on('createMarket', (data) => {
        if (!data || !data.question || !data.endDate) {
            socket.emit('error', { message: 'Missing market data' });
            return;
        }

        const market = createMarket(data);
        io.emit('marketCreated', {
            market,
            allMarkets: getAllMarkets(),
        });
    });

    socket.on('placeBet', ({ marketId, player, side, amount }) => {
        if (!marketId || !player || !side || !amount) {
            socket.emit('error', { message: 'Missing bet data' });
            return;
        }

        const parsedAmount = parseInt(amount);
        if (isNaN(parsedAmount) || parsedAmount < 1) {
            socket.emit('error', { message: 'Invalid bet amount' });
            return;
        }

        const playerData = getPlayer(player);
        if (!playerData) {
            socket.emit('error', { message: 'Player not found' });
            return;
        }
        if (playerData.balance < parsedAmount) {
            socket.emit('error', { message: `Not enough SHC! You have ${Math.round(playerData.balance)}` });
            return;
        }

        const bet = placeBet(marketId, player, side, parsedAmount);
        if (!bet) {
            socket.emit('error', { message: 'Could not place bet' });
            return;
        }

        io.emit('betPlaced', {
            bet,
            market: getMarket(marketId),
            allPlayers: getAllPlayers(),
        });
    });

    socket.on('resolveMarket', ({ marketId, resolution, resolvedBy }) => {
        if (!marketId || !resolution || !resolvedBy) {
            socket.emit('error', { message: 'Missing resolve data' });
            return;
        }

        const market = getMarket(marketId);
        if (!market) {
            socket.emit('error', { message: 'Market not found' });
            return;
        }
        if (resolvedBy !== 'Matan') {
            socket.emit('error', { message: 'Only Matan can resolve markets' });
            return;
        }
        if (market.resolved) {
            socket.emit('error', { message: 'Market already resolved' });
            return;
        }

        resolveMarket(marketId, resolution);

        io.emit('marketResolved', {
            market: getMarket(marketId),
            allPlayers: getAllPlayers(),
            marketBets: getBetsForMarket(marketId),
        });
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

server.listen(PORT, () => {
    console.log(`Sharmutocoin server running on port ${PORT}`);
});
