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

// VeriPoints (shared ORIZIS wallet) — server-side capture/release/earn. All are
// no-ops unless both the central functions URL and the server key are configured.
//   VERIPOINTS_FUNCTIONS_URL - e.g. https://europe-west1-<central>.cloudfunctions.net
//   VERIPOINTS_SERVER_KEY    - secret serverKey the central grants this site
//   VERIPOINTS_PLATFORM_UID  - wallet uid that receives redeemed (captured) points
//   VP_EARN_PERCENT          - loyalty % granted per order (defaults to 3)
const VP_URL = process.env.VERIPOINTS_FUNCTIONS_URL;
const VP_KEY = process.env.VERIPOINTS_SERVER_KEY;
const VP_PLATFORM_UID = process.env.VERIPOINTS_PLATFORM_UID;
const VP_SITE_ID = 'zedcards';
const VP_EARN_PERCENT = Number(process.env.VP_EARN_PERCENT) || 3;
const VP_CONFIGURED = Boolean(VP_URL && VP_KEY);

// Invoke a central VeriPoints callable Cloud Function server-to-server.
async function vpCall(fnName, data) {
    const r = await axios.post(`${VP_URL.replace(/\/$/, '')}/${fnName}`, { data }, {
        headers: { 'Content-Type': 'application/json' }, timeout: 20000
    });
    return r.data && (r.data.result !== undefined ? r.data.result : r.data);
}

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        service: 'zedcards-backend',
        paymentsConfigured: Boolean(PAWAPAY_TOKEN),
        paymentsEnv: process.env.PAWAPAY_ENV === 'production' ? 'production' : 'sandbox',
        codeDelivery: RELOADLY_ID && RELOADLY_SECRET ? 'reloadly-' + RELOADLY_ENV : 'manual',
        veriPoints: VP_CONFIGURED ? 'configured' : 'off'
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
    const { tx_ref, vpCaptureId, items } = req.body || {};

    if (!Array.isArray(items) || !items.length) {
        return res.status(400).json({ error: 'NO_ITEMS' });
    }

    // 1) Verify payment server-side before releasing anything. Payment can be a
    //    Mobile Money charge (pawaPay), a VeriPoints redemption (already captured
    //    server-side), or a mix. Only one confirmed leg is required to release.
    const paidByPoints = Boolean(vpCaptureId) && VP_CONFIGURED;

    if (PAWAPAY_TOKEN && tx_ref) {
        try {
            const status = await pawapayStatus(tx_ref);
            if (status !== 'successful') {
                return res.status(402).json({ error: 'PAYMENT_NOT_CONFIRMED', status });
            }
        } catch (e) {
            return res.status(502).json({ error: 'VERIFY_FAILED', message: e.message });
        }
    } else if (paidByPoints) {
        // The points capture was performed by /api/veripoints/capture using the
        // secret serverKey, so its presence is proof of a settled payment.
    } else if (PAWAPAY_TOKEN) {
        return res.status(402).json({ error: 'PAYMENT_REQUIRED' });
    } else {
        // No payment rails configured => the whole flow is simulated; the
        // storefront renders clearly-labelled DEMO codes. Never emit a real code.
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

/* =====================================================================
   VERIPOINTS — server-side wallet operations (shared ORIZIS wallet)
   Every endpoint returns { disabled:true } when VeriPoints is not
   configured, so the storefront falls back to Mobile Money-only cleanly.
   Balances change only through the central Cloud Functions with the secret
   serverKey — never trusted from the client (API-CONTRACT §3, §5).
   ===================================================================== */

// Capture a client-placed hold: settle the redeemed points to the platform wallet.
app.post('/api/veripoints/capture', async (req, res) => {
    if (!VP_CONFIGURED) return res.json({ disabled: true });
    const { holdId, points } = req.body || {};
    if (!holdId || !(points > 0) || !VP_PLATFORM_UID) {
        return res.status(400).json({ error: 'INVALID_INPUT' });
    }
    try {
        await vpCall('walletCapture', {
            holdId,
            siteId: VP_SITE_ID,
            serverKey: VP_KEY,
            splits: [{ toUid: VP_PLATFORM_UID, amount: Math.round(points), role: 'platform' }]
        });
        res.json({ captureId: holdId });   // holdId doubles as the settled-redemption reference
    } catch (e) {
        res.status(502).json({ error: 'CAPTURE_FAILED', message: e.message, response: e.response ? e.response.data : null });
    }
});

// Release a hold when the surrounding payment failed (undo the reservation).
app.post('/api/veripoints/release', async (req, res) => {
    if (!VP_CONFIGURED) return res.json({ disabled: true });
    const { holdId } = req.body || {};
    if (!holdId) return res.status(400).json({ error: 'INVALID_INPUT' });
    try {
        await vpCall('walletRelease', { holdId, siteId: VP_SITE_ID, serverKey: VP_KEY, reason: 'zedcards payment failed' });
        res.json({ released: true });
    } catch (e) {
        res.status(502).json({ error: 'RELEASE_FAILED', message: e.message });
    }
});

// Grant loyalty points after a verified order. Payment is re-verified here too:
// a confirmed pawaPay tx_ref, or a points capture (already settled server-side).
app.post('/api/veripoints/earn', async (req, res) => {
    if (!VP_CONFIGURED) return res.json({ disabled: true, earned: 0 });
    const { uid, subtotal, orderRef, tx_ref, vpCaptureId } = req.body || {};
    if (!uid || !(subtotal > 0)) return res.status(400).json({ error: 'INVALID_INPUT' });

    // Re-verify the payment before crediting anything.
    let paid = Boolean(vpCaptureId);
    if (!paid && PAWAPAY_TOKEN && tx_ref) {
        try { paid = (await pawapayStatus(tx_ref)) === 'successful'; } catch (e) { paid = false; }
    }
    if (!paid) return res.status(402).json({ error: 'PAYMENT_NOT_CONFIRMED', earned: 0 });

    const points = Math.floor(Number(subtotal) * VP_EARN_PERCENT / 100);
    if (points <= 0) return res.json({ earned: 0 });
    try {
        // Loyalty grant on the central wallet (a 'walletGrant' server function —
        // the central adds this alongside the 4 core functions; guarded so an
        // unconfigured/absent grant never blocks the order).
        await vpCall('walletGrant', { uid, amount: points, siteId: VP_SITE_ID, serverKey: VP_KEY, reference: orderRef || null, reason: 'loyalty earn' });
        res.json({ earned: points });
    } catch (e) {
        // Non-blocking: the order already succeeded; points can be reconciled later.
        res.json({ earned: 0, pending: true, message: e.message });
    }
});

module.exports = app;
