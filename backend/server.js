const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { randomUUID } = require('crypto');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

/* =====================================================================
   ZEDCARDS BACKEND
   Environment variables (Vercel -> Project Settings -> Environment Vars):
     PAWAPAY_TOKEN          - pawaPay API token. Without it, /api/pay reports
                              simulated mode and the storefront simulates.
     PAWAPAY_ENV            - 'sandbox' (default) or 'production'.
     RELOADLY_CLIENT_ID     - Reloadly API client id (gift-card auto-delivery).
     RELOADLY_CLIENT_SECRET - Reloadly API client secret.
     RELOADLY_ENV           - 'sandbox' (default) or 'production'.
   Code delivery (/api/redeem) ALWAYS re-verifies the payment server-side
   (pawaPay tx_ref must be COMPLETED) before releasing any code. Codes are
   sourced only from Reloadly (authorized distributor) — never grey-market.
   ===================================================================== */

const PAWAPAY_TOKEN = process.env.PAWAPAY_TOKEN;
const PAWAPAY_BASE = process.env.PAWAPAY_ENV === 'production'
    ? 'https://api.pawapay.io'
    : 'https://api.sandbox.pawapay.io';

const RELOADLY_ID = process.env.RELOADLY_CLIENT_ID;
const RELOADLY_SECRET = process.env.RELOADLY_CLIENT_SECRET;
const RELOADLY_ENV = process.env.RELOADLY_ENV === 'production' ? 'production' : 'sandbox';
const RELOADLY_GC_BASE = RELOADLY_ENV === 'production'
    ? 'https://giftcards.reloadly.com'
    : 'https://giftcards-sandbox.reloadly.com';

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        service: 'zedcards-backend',
        paymentsConfigured: Boolean(PAWAPAY_TOKEN),
        paymentsEnv: process.env.PAWAPAY_ENV === 'production' ? 'production' : 'sandbox',
        codeDelivery: RELOADLY_ID && RELOADLY_SECRET ? 'reloadly-' + RELOADLY_ENV : 'manual'
    });
});

/* =====================================================================
   MOBILE MONEY PAYMENTS (pawaPay - Zambia)
   ===================================================================== */

const PAWAPAY_PROVIDERS = {
    mtn: 'MTN_MOMO_ZMB',
    airtel: 'AIRTEL_OAPI_ZMB',
    zamtel: 'ZAMTEL_ZMB'
};

const pawapayHeaders = () => ({
    Authorization: `Bearer ${PAWAPAY_TOKEN}`,
    'Content-Type': 'application/json'
});

// Starts a mobile money deposit. The customer approves with a PIN prompt;
// the storefront polls /api/pay/status until it resolves.
app.post('/api/pay', async (req, res) => {
    if (!PAWAPAY_TOKEN) return res.json({ simulated: true });

    const { phone, network, amount } = req.body || {};
    const provider = PAWAPAY_PROVIDERS[String(network || '').toLowerCase()];
    if (!/^(9|7)\d{8}$/.test(String(phone)) || !(amount > 0) || !provider) {
        return res.status(400).json({ error: 'INVALID_INPUT' });
    }

    const depositId = randomUUID();
    try {
        const r = await axios.post(`${PAWAPAY_BASE}/v2/deposits`, {
            depositId,
            amount: String(Math.round(amount * 100) / 100),
            currency: 'ZMW',
            payer: {
                type: 'MMO',
                accountDetails: { phoneNumber: '260' + phone, provider }
            },
            customerMessage: 'ZedCards order'
        }, { headers: pawapayHeaders(), timeout: 25000 });

        res.json({ tx_ref: depositId, status: r.data && r.data.status });
    } catch (error) {
        res.status(502).json({
            error: 'PAYMENT_ERROR',
            message: error.message,
            response: error.response ? error.response.data : null
        });
    }
});

// Normalizes a pawaPay deposit into successful / failed / pending.
async function pawapayStatus(txRef) {
    const r = await axios.get(`${PAWAPAY_BASE}/v2/deposits/${encodeURIComponent(txRef)}`, {
        headers: pawapayHeaders(),
        timeout: 20000
    });
    const d = r.data && (r.data.data || (Array.isArray(r.data) ? r.data[0] : r.data));
    const s = String((d && d.status) || 'pending').toUpperCase();
    return s === 'COMPLETED' ? 'successful'
        : (s === 'FAILED' || s === 'REJECTED' || s === 'CANCELLED') ? 'failed'
        : 'pending';
}

app.get('/api/pay/status', async (req, res) => {
    if (!PAWAPAY_TOKEN) return res.json({ simulated: true, status: 'successful' });
    try {
        res.json({ status: await pawapayStatus(req.query.tx_ref || '') });
    } catch (error) {
        // Status can 404 briefly right after initiation - treat as pending
        res.json({ status: 'pending' });
    }
});

/* =====================================================================
   CODE DELIVERY (/api/redeem)
   Releases codes ONLY after re-verifying the payment server-side. When
   Reloadly is configured the codes are purchased live from the authorized
   distributor; otherwise the order is flagged for manual fulfilment (the
   storefront tells the buyer their code is on its way by email/WhatsApp).
   ===================================================================== */

// Reloadly OAuth token (cached in-memory for the life of the serverless instance)
let reloadlyToken = null;
let reloadlyTokenExp = 0;
async function getReloadlyToken() {
    if (reloadlyToken && Date.now() < reloadlyTokenExp - 60000) return reloadlyToken;
    const r = await axios.post('https://auth.reloadly.com/oauth/token', {
        client_id: RELOADLY_ID,
        client_secret: RELOADLY_SECRET,
        grant_type: 'client_credentials',
        audience: RELOADLY_GC_BASE
    }, { timeout: 20000 });
    reloadlyToken = r.data.access_token;
    reloadlyTokenExp = Date.now() + (r.data.expires_in || 3600) * 1000;
    return reloadlyToken;
}

// NOTE: mapping each ZedCards item to a Reloadly productId + unitPrice is the
// last integration step (needs Yoni's Reloadly account + product catalog).
// Until productIds are wired, redeem falls back to manual fulfilment so the
// shop never hands out an unverified code. This keeps rule #1 (authorized
// source only) and #6 (deliver only after verified payment) intact.
async function reloadlyRedeem(items) {
    // Placeholder for the live Reloadly order call. Returns [] to signal
    // "auto-delivery not wired yet" -> manual fulfilment path.
    // When ready: getReloadlyToken(), POST /orders per item.productId, then
    // GET /orders/transactions/{id}/cards to read the code, and return
    // [{ brand, denom, code, pin, redeem }].
    return [];
}

app.post('/api/redeem', async (req, res) => {
    const { tx_ref, items } = req.body || {};

    if (!Array.isArray(items) || !items.length) {
        return res.status(400).json({ error: 'NO_ITEMS' });
    }

    // 1) Verify payment server-side before releasing anything.
    if (PAWAPAY_TOKEN) {
        if (!tx_ref) return res.status(402).json({ error: 'PAYMENT_REQUIRED' });
        try {
            const status = await pawapayStatus(tx_ref);
            if (status !== 'successful') {
                return res.status(402).json({ error: 'PAYMENT_NOT_CONFIRMED', status });
            }
        } catch (e) {
            return res.status(502).json({ error: 'VERIFY_FAILED', message: e.message });
        }
    } else {
        // No payments configured => whole flow is simulated; the storefront
        // renders clearly-labelled DEMO codes. Never emit a real code here.
        return res.json({ simulated: true });
    }

    // 2) Payment confirmed. Try authorized auto-delivery (Reloadly).
    if (RELOADLY_ID && RELOADLY_SECRET) {
        try {
            const codes = await reloadlyRedeem(items);
            if (codes.length) return res.json({ codes });
        } catch (e) {
            console.warn('Reloadly delivery failed, falling back to manual:', e.message);
        }
    }

    // 3) No auto-supplier (yet) => manual fulfilment. Payment is already
    //    confirmed, so the team issues the genuine code by email/WhatsApp.
    return res.json({ pending: true });
});

module.exports = app;
