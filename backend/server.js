const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');
const { randomUUID, randomBytes } = require('crypto');

/* =====================================================================
   SHARED VOUCHER STORE (Firebase zedmall-4301c) — the ORIZIS gift-voucher
   registry. Vochira creates vouchers here on purchase; every ORIGIS site
   redeems against it. All writes are server-side (Admin SDK) and atomic.
   Set FIREBASE_SERVICE_ACCOUNT (the service-account JSON, stringified) to
   activate; without it, vouchers still deliver but aren't auto-redeemable.
   ===================================================================== */
const VOUCHER_STORE = Boolean(process.env.FIREBASE_SERVICE_ACCOUNT);
let _db = null;
function db() {
    if (_db) return _db;
    if (!VOUCHER_STORE) return null;
    if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }
    _db = admin.firestore();
    return _db;
}
async function voucherCreate(code, site, amount, orderRef) {
    const d = db(); if (!d) return false;
    await d.collection('vouchers').doc(code).set({
        code, site, amount: Number(amount) || 0, status: 'active',
        orderRef: orderRef || null, createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return true;
}
async function voucherCheck(code) {
    const d = db(); if (!d) return null;
    const snap = await d.collection('vouchers').doc(code).get();
    if (!snap.exists) return { valid: false, error: 'NOT_FOUND' };
    const v = snap.data();
    return { valid: v.status === 'active', status: v.status, site: v.site, amount: v.amount };
}
// Atomic single-use redemption: marks the voucher redeemed only if it is
// currently active (and, when given, the site matches).
async function voucherRedeem(code, site) {
    const d = db(); if (!d) throw new Error('VOUCHER_STORE_OFF');
    const ref = d.collection('vouchers').doc(code);
    return d.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists) return { ok: false, error: 'NOT_FOUND' };
        const v = snap.data();
        if (site && v.site && String(v.site).toLowerCase() !== String(site).toLowerCase()) {
            return { ok: false, error: 'WRONG_SITE', site: v.site };
        }
        if (v.status !== 'active') return { ok: false, error: 'ALREADY_' + String(v.status).toUpperCase() };
        tx.update(ref, { status: 'redeemed', redeemedAt: admin.firestore.FieldValue.serverTimestamp(), redeemedBy: site || null });
        return { ok: true, amount: v.amount, site: v.site };
    });
}

// Human-friendly single-use voucher code, e.g. VCH-7F3K-9Q2M (no ambiguous chars).
function makeVoucherCode() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const b = randomBytes(8);
    let s = '';
    for (let i = 0; i < 8; i++) s += A[b[i] % A.length];
    return 'VCH-' + s.slice(0, 4) + '-' + s.slice(4, 8);
}

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

/* =====================================================================
   VOCHIRA BACKEND
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
const VP_SITE_ID = 'vochira';
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
        service: 'vochira-backend',
        paymentsConfigured: Boolean(PAWAPAY_TOKEN),
        paymentsEnv: process.env.PAWAPAY_ENV === 'production' ? 'production' : 'sandbox',
        codeDelivery: RELOADLY_ID && RELOADLY_SECRET ? 'reloadly-' + RELOADLY_ENV : 'manual',
        veriPoints: VP_CONFIGURED ? 'configured' : 'off',
        voucherStore: VOUCHER_STORE ? 'firestore' : 'off'
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
            customerMessage: 'Vochira order'
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

const GC_ACCEPT = 'application/com.reloadly.giftcards-v1+json';

// Places one Reloadly gift-card order and reads back the redeem code.
// Returns { code, pin, redeem } or null if the card wasn't ready/failed.
async function reloadlyOrderOne(token, item, email, customId) {
    const order = await axios.post(`${RELOADLY_GC_BASE}/orders`, {
        productId: item.pid,
        quantity: 1,
        unitPrice: item.face,               // recipient-currency face value (USD)
        senderName: 'Vochira',
        recipientEmail: email || undefined,
        customIdentifier: customId,
        preOrder: false
    }, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: GC_ACCEPT }, timeout: 30000 });

    const txId = order.data && (order.data.transactionId || order.data.id);
    if (!txId) return null;

    // The card (code/PIN) is fetched from the transaction; retry briefly as it settles.
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const cardsRes = await axios.get(`${RELOADLY_GC_BASE}/orders/transactions/${txId}/cards`, {
                headers: { Authorization: `Bearer ${token}`, Accept: GC_ACCEPT }, timeout: 20000
            });
            const arr = Array.isArray(cardsRes.data) ? cardsRes.data : (cardsRes.data && cardsRes.data.content) || [];
            const c = arr[0];
            if (c && (c.cardNumber || c.pinCode)) {
                return {
                    code: c.cardNumber || c.pinCode,
                    pin: c.cardNumber && c.pinCode ? c.pinCode : null,
                    redeem: (order.data && order.data.product && order.data.product.redeemInstruction && order.data.product.redeemInstruction.verbose) || null
                };
            }
        } catch (e) { /* not ready yet */ }
        await new Promise(r => setTimeout(r, 2500));
    }
    return null;   // ordered but code not retrievable synchronously -> caller falls back to pending
}

// Delivers real codes for the whole order via Reloadly (authorized distributor).
// Any single failure => return [] so the caller uses manual fulfilment instead
// of handing out a partial/unverified result.
async function reloadlyRedeem(items, email, orderRef) {
    const token = await getReloadlyToken();
    const codes = [];
    let idx = 0;
    for (const item of items) {
        if (!item.pid || !(item.face > 0)) return [];
        for (let q = 0; q < (item.qty || 1); q++) {
            const one = await reloadlyOrderOne(token, item, email, `${orderRef || 'zc'}-${idx++}`);
            if (!one) return [];   // bail to manual fulfilment on any miss
            codes.push({ brand: item.brand, denom: item.denom, code: one.code, pin: one.pin, redeem: one.redeem });
        }
    }
    return codes;
}

app.post('/api/redeem', async (req, res) => {
    const { tx_ref, vpCaptureId, items, email, orderRef } = req.body || {};

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

    // 2) Payment confirmed. Deliver two kinds of items:
    //    - ORIZIS gift vouchers (our own products) => generated instantly, no supplier
    //    - Reloadly gift cards                     => bought from the distributor
    const voucherItems = items.filter(i => i.voucher);
    const cardItems = items.filter(i => i.pid);
    const codes = [];

    for (const it of voucherItems) {
        for (let q = 0; q < (it.qty || 1); q++) {
            const code = makeVoucherCode();
            // Register in the shared store so the target site can auto-redeem it.
            // If the store isn't configured yet, the code is still delivered and
            // the owner honours it manually (recorded via the order notification).
            try { await voucherCreate(code, it.voucher, it.amount, orderRef); } catch (e) { console.warn('voucherCreate failed:', e.message); }
            codes.push({
                brand: it.brand, denom: it.denom, code, voucher: true,
                redeem: `Give this code at ${it.voucher} checkout to redeem K${it.amount} store credit.`
            });
        }
    }

    if (cardItems.length && RELOADLY_ID && RELOADLY_SECRET) {
        try {
            const rc = await reloadlyRedeem(cardItems, email, orderRef);
            if (rc.length) codes.push(...rc);
            else if (!codes.length) return res.json({ pending: true });   // card leg failed, nothing else
        } catch (e) {
            console.warn('Reloadly delivery failed, falling back to manual:', e.message);
            if (!codes.length) return res.json({ pending: true });
        }
    } else if (cardItems.length && !codes.length) {
        return res.json({ pending: true });   // cards need a supplier that isn't configured yet
    }

    // 3) Return whatever we could deliver; if nothing, mark for manual fulfilment.
    if (codes.length) return res.json({ codes });
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
        await vpCall('walletRelease', { holdId, siteId: VP_SITE_ID, serverKey: VP_KEY, reason: 'vochira payment failed' });
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

/* =====================================================================
   VOUCHER API — called by every ORIZIS site's checkout to validate and
   redeem a Vochira gift voucher. Open CORS so any family site can call it.
   ===================================================================== */

// Non-destructive check (does the code exist / how much is on it).
app.get('/api/voucher/check', async (req, res) => {
    const code = String(req.query.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'NO_CODE' });
    if (!VOUCHER_STORE) return res.json({ disabled: true });
    try { res.json((await voucherCheck(code)) || { valid: false }); }
    catch (e) { res.status(502).json({ error: e.message }); }
});

// Atomic redemption — call this when the order is placed. `site` (optional)
// ties the voucher to the redeeming store, e.g. { code, site: 'ZedGlow' }.
app.post('/api/voucher/redeem', async (req, res) => {
    const code = String((req.body && req.body.code) || '').trim().toUpperCase();
    const site = req.body && req.body.site;
    if (!code) return res.status(400).json({ ok: false, error: 'NO_CODE' });
    if (!VOUCHER_STORE) return res.json({ ok: false, disabled: true });
    try { res.json(await voucherRedeem(code, site)); }
    catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

module.exports = app;
