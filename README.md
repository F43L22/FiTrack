# FiTrack

A quiet, minimal personal-finance dashboard for you — and whoever you share it
with. One screen. No tabs. Everything you need to see your money across months
and years, and nothing you don't.

![one dashboard, everything on it](https://img.shields.io/badge/UI-single%20dashboard-2f6f5e) ![no build step](https://img.shields.io/badge/build-none-444) ![secured by RLS](https://img.shields.io/badge/data-row%20level%20secured-2f6f5e)

## What it does

- **One clean dashboard** — income, spending, savings, net worth, cashflow,
  budgets, accounts, goals and recent transactions, all on a single calm page.
- **Months & years** — flip between any month or zoom out to a full year with
  one tap. A 12-month cashflow chart gives you the shape of your year at a glance.
- **Add your partner** — your spouse signs up and joins your household with an
  invite code. You both see and edit the same finances, live, from any device.
  Every transaction can be attributed to a person, and you can filter the whole
  dashboard by who.
- **Accounts** — checking, savings, cash, credit, investments. Balances are
  computed automatically from your opening balance + transactions + transfers.
- **Budgets** — set a monthly budget per category and watch the bars fill;
  they turn red when you go over.
- **Savings goals** — track progress toward the holiday, the house, the buffer.
- **Transfers** — move money between accounts without distorting income/spend.
- **Private by design** — every row is protected by Postgres Row-Level Security.
  Only signed-in members of your household can read or write your data.
- **Export** — download a full JSON backup of your household anytime.

## Architecture

Deliberately tiny and dependency-free:

| Piece | What |
|-------|------|
| `index.html` | Markup for the auth screen, onboarding, and the dashboard shell. |
| `styles.css` | The entire visual language. Auto light/dark. |
| `app.js` | All logic — auth, data, computations, rendering, modals. Plain `fetch`, no frameworks. |
| `config.js` | Supabase URL + public anon key. |
| Supabase | Postgres database (schema `fitrack`) + Auth. |

The browser talks directly to Supabase's REST (PostgREST) and Auth (GoTrue)
endpoints over `fetch`. There is no server to run and nothing to build.

### Data model (schema `fitrack`)

- `households` — one per family, with a shareable `invite_code` and currency.
- `members` — people in a household, linked to their login, with name + colour.
- `accounts` — where money lives; balances are derived, not stored.
- `categories` — income/expense buckets, each with an optional monthly budget.
- `transactions` — income, expense, or transfer; dated, attributed, categorised.
- `goals` — savings targets with progress.

Two `SECURITY DEFINER` RPCs handle onboarding safely: `create_household` (also
seeds a starter account + sensible categories) and `join_household` (joins an
existing household by invite code).

## Running it

There's no build. Either:

**Open it directly** — double-click `index.html`. (Works because all calls go
to Supabase over HTTPS.)

**Or serve it locally** (nicer URL, recommended):

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

**Or host it anywhere static** — Netlify, Vercel, GitHub Pages, Cloudflare
Pages, an S3 bucket. Just upload the four files.

## First-time setup

1. Open the app and **Create an account** (email + password). You're signed in
   instantly — no confirmation email to wait for.
2. On the welcome step choose **Start fresh**, enter your name, your household
   name, and your currency.
3. Open **Settings (⚙) → Household** to find your **invite code**.
4. Your partner opens FiTrack, creates an account, then on the welcome step picks
   **Join a partner** and enters your code. Done — you're both on the same books.

## Notes

- The public anon key in `config.js` is safe to ship in the browser. It grants
  no access on its own — Row-Level Security requires a valid signed-in session
  scoped to your household.
- FiTrack lives in its own isolated `fitrack` schema and shares only the login
  system with anything else in the same Supabase project; your finance data is
  fully separated.
