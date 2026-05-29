# Deploy frontend on Vercel (backend on Render)

Backend API: **https://microfinance-backend-5y3w.onrender.com**

Health check: https://microfinance-backend-5y3w.onrender.com/health

---

## 1. Render backend environment (required)

In [Render](https://dashboard.render.com) → your backend service → **Environment**, set or update:

| Variable | Example | Purpose |
|----------|---------|---------|
| `NODE_ENV` | `production` | Production mode |
| `CORS_ORIGIN` | `https://your-app.vercel.app` | Allow your Vercel site (comma-separate multiple URLs) |
| `FRONTEND_URL` | `https://your-app.vercel.app` | Used for links / redirects if needed |
| `JWT_SECRET` | *(strong secret)* | Auth |
| `DATABASE_URL` | *(your Postgres URL)* | Database |

After you know your Vercel URL, add it to `CORS_ORIGIN`. You can use several origins:

```text
https://your-app.vercel.app,https://your-app-git-main-prinstinegroupofcompanies.vercel.app
```

Redeploy the backend after changing env vars.

The backend also allows `*.vercel.app` in production when `NODE_ENV=production`.

---

## 2. Vercel project setup

1. Go to [vercel.com](https://vercel.com) and **Add New Project**.
2. Import the GitHub repo: `prinstinegroupofcompanies/prinstine-microfinance-system`.
3. Configure the project:

| Setting | Value |
|---------|--------|
| **Root Directory** | `frontend` |
| **Framework Preset** | Vite (auto-detected) |
| **Build Command** | `npm run build` |
| **Output Directory** | `dist` |
| **Install Command** | `npm install` |

4. **Environment Variables** (Production, Preview, and Development):

| Name | Value |
|------|--------|
| `VITE_API_URL` | `https://microfinance-backend-5y3w.onrender.com` |

No trailing slash on the URL.

5. Click **Deploy**.

`frontend/vercel.json` already configures SPA routing so React Router paths work on refresh.

---

## 3. After first deploy

1. Copy your Vercel URL (e.g. `https://prinstine-microfinance-system.vercel.app`).
2. Update Render backend `CORS_ORIGIN` and `FRONTEND_URL` with that URL.
3. Redeploy the backend on Render.
4. Open the Vercel site, log in, and confirm API calls in the browser **Network** tab go to `microfinance-backend-5y3w.onrender.com`.

---

## 4. Custom domain (optional)

**Vercel:** Project → Settings → Domains → add your domain.

**Render:** Add the same domain to `CORS_ORIGIN` and `FRONTEND_URL`, e.g.:

```text
https://app.yourdomain.com
```

---

## 5. Local development

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev
```

`.env.local` should contain:

```text
VITE_API_URL=https://microfinance-backend-5y3w.onrender.com
```

Or use `http://localhost:5000` if the backend runs locally.

---

## 6. Troubleshooting

| Issue | Fix |
|-------|-----|
| CORS error in browser | Add exact Vercel URL to Render `CORS_ORIGIN`; redeploy backend |
| API calls go to Vercel domain | Set `VITE_API_URL` on Vercel and redeploy frontend |
| Blank page on refresh | Ensure `frontend` root and `vercel.json` rewrites are used |
| Images not loading | `VITE_API_URL` must be set so `/uploads/...` loads from Render |
| 401 on login | Backend DB and `JWT_SECRET` must match production data |

---

## 7. Deploy from CLI (optional)

```bash
cd frontend
npm i -g vercel
vercel login
vercel --prod
```

Set `VITE_API_URL` in the Vercel dashboard or when prompted.
