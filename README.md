# Vochira 🇿🇲🎁

Zambia's instant store for **genuine gift cards & subscription codes** — Netflix, DSTV, GOtv,
Showmax, Spotify, Apple Music, Google Play, Apple/iTunes, Free Fire, PUBG Mobile, Mobile Legends,
Roblox and Amazon. Paid for with **Mobile Money** (MTN / Airtel / Zamtel), with **instant digital
code delivery** — no shipping. An **ORIZIS TECHNOLOGY** brand.

Sibling of ZedGlow / ZedTech, but the product is a *code*, not a physical item: no shipping
address, and delivery is instant on the success screen (plus email + WhatsApp copy).

## Architecture

- **`index.html`** — the whole storefront (single file). Local `BRANDS` catalog (no external
  product API), cart, Mobile Money checkout, on-screen code delivery, PWA, ORIZIS intro splash.
- **`backend/server.js`** — Express API on Vercel:
  - `POST /api/pay` + `GET /api/pay/status` — pawaPay Mobile Money.
  - `POST /api/redeem` — **releases codes only after re-verifying the payment server-side**
    (pawaPay `tx_ref` must be `COMPLETED`). Auto-delivery via Reloadly (authorized distributor)
    when configured; otherwise the order is flagged for manual fulfilment.
  - `GET /api/health` — status (payments + code-delivery mode).

## Source of codes — authorized only

Codes come **only from Reloadly or official brand distributors** — never AliExpress / grey market.
Grey-market codes = chargeback, fraud and legal risk. This is a hard rule.

## Config (top of `index.html`)

| key | meaning |
|-----|---------|
| `API_BASE_URL` | backend URL (`""` = full demo mode: simulated payment + demo codes) |
| `SERVICE_FEE_PERCENT` | small fee shown at checkout (covers MoMo charges) |
| `WHATSAPP_ORDERS` | business line every paid order is copied to |
| `WHATSAPP_SUPPORT` | customer support WhatsApp (support section only — no floating button) |

Prices are set **directly in Kwacha** per denomination (bought wholesale from an authorized
distributor, sold with margin) — no USD conversion.

## Go-live checklist (Yoni's secrets)

1. **`PAWAPAY_TOKEN`** + `PAWAPAY_ENV=production` in Vercel → real Mobile Money (else simulated).
2. **`RELOADLY_CLIENT_ID` / `RELOADLY_CLIENT_SECRET`** (+ `RELOADLY_ENV=production`) → automatic
   real-code delivery. Final wiring step: map each catalog denomination to a Reloadly `productId`
   in `reloadlyRedeem()`. Until then, paid orders use **manual fulfilment** (code sent by
   email/WhatsApp after confirmed payment — never an unverified code).
3. Real **`WHATSAPP_ORDERS` / `WHATSAPP_SUPPORT`** numbers (business line) in `CONFIG`.
4. (Optional) custom domain via `CNAME` + GoDaddy DNS.

## Deploy

- **Storefront** → GitHub Pages: `git push` to `main`.
- **Backend** → Vercel: `cd backend && npx vercel --prod --yes` (Root Directory = `backend`).
  Check `https://zedcards-site.vercel.app/api/health`.

© 2026 Vochira Zambia · an ORIZIS TECHNOLOGY brand.
