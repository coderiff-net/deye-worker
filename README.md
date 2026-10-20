# SASW Energy Worker

## Overview

SASW Energy Worker helps manage energy use at home through secure APIs. Its first job checks Deye solar production and an Ariston water heater every 15 minutes during daytime. It may switch the heater to manual mode when there is enough solar energy and the water can be heated further. It enables Eco mode when the water reaches Ariston requested temperature (`reqTemp`). The project can grow into other home energy controls through secure APIs.

The deployed website is [https://sasw-energy-worker.coderiff.workers.dev/](https://sasw-energy-worker.coderiff.workers.dev/). It is protected by Cloudflare Access, so an authorized user must sign in before opening it or invoking the manual check. `GET /` serves a small status page with a **Check now** button. `POST /check` invokes the same runner manually, including at night; the scheduled handler still runs without an HTTP request.

## Requirements

- Node.js and npm
- A Cloudflare account
- Wrangler, installed as a project dependency

Install the project dependencies once:

```sh
npm install
```

## Run locally

Start the local Worker with:

```sh
npm run dev
```

Wrangler reads local-only values from `.dev.vars`. Start from the checked-in example and replace the placeholders:

```sh
cp .dev.vars.example .dev.vars
```

On Windows PowerShell, use `Copy-Item .dev.vars.example .dev.vars` instead. `.dev.vars` is ignored by Git. Do not commit it or paste real credentials into `.dev.vars.example`. Keep `DRY_RUN=true` in `.dev.vars` until you intentionally want a local run to change the Ariston mode.

The example contains these bindings:

| Binding | Purpose | Suggested storage |
| --- | --- | --- |
| `DEYE_APP_ID` | Deye application identifier | `vars` in `wrangler.jsonc`; use a secret if you prefer to keep it private |
| `DEYE_APP_SECRET` | Deye application secret | Cloudflare secret; `.dev.vars` for local development |
| `DEYE_EMAIL` | Deye account email | `vars` if acceptable for the repository; otherwise a Cloudflare secret and `.dev.vars` |
| `DEYE_PASSWORD` | SHA-256 hex digest of the Deye account password, as used by Bruno | Cloudflare secret; `.dev.vars` for local development |
| `DEYE_STATION_ID` | Deye station identifier | `vars` in `wrangler.jsonc` |
| `ARISTON_EMAIL` | Ariston account email | `vars` if acceptable for the repository; otherwise a Cloudflare secret and `.dev.vars` |
| `ARISTON_PASSWORD` | Ariston account password | Cloudflare secret; `.dev.vars` for local development |
| `ARISTON_GATEWAY` | Ariston gateway identifier | `vars` in `wrangler.jsonc` |
| `DRY_RUN` | When `true`, read data and log the intended change without sending the Ariston mode POST | `.dev.vars` for safe local checks; omit in production |

`.dev.vars` is for your local Wrangler process. Cloudflare does not receive its values when you deploy. Use Cloudflare secrets for production credentials.

## Non-secret settings in `wrangler.jsonc`

Wrangler configuration is checked into Git so the Worker can be deployed consistently. Put non-secret configuration in the top-level `vars` object in `wrangler.jsonc`:

```jsonc
"vars": {
  "DEYE_APP_ID": "replace-with-your-app-id",
  "DEYE_STATION_ID": "replace-with-your-station-id",
  "ARISTON_GATEWAY": "replace-with-your-gateway-id"
}
```

You can also put email addresses there if you are comfortable with them being visible to anyone who can read the repository. If the repository is public, consider those addresses private and store them as Cloudflare secrets instead. Never put passwords or application secrets in `wrangler.jsonc`.

`vars` are deployed with the Worker and made available to code through the `env` parameter. For example, `env.DEYE_STATION_ID`. If you add or change Worker bindings in `wrangler.jsonc`, refresh the generated TypeScript types:

```sh
npx wrangler types
```

## Production secrets in Cloudflare

Create secrets on the deployed Worker with Wrangler. Run each command from the project directory while authenticated to the correct Cloudflare account. Wrangler prompts for the value; enter it at the prompt rather than putting it in the command itself.

```sh
npx wrangler secret put DEYE_APP_SECRET
npx wrangler secret put DEYE_PASSWORD
npx wrangler secret put ARISTON_PASSWORD
```

`DEYE_PASSWORD` must contain the already hashed 64-character SHA-256 digest used in Bruno. The Worker sends it directly to Deye and does not hash it again. Treat this digest as a credential.

If you choose to keep either email address private, add it as a secret too:

```sh
npx wrangler secret put DEYE_EMAIL
npx wrangler secret put ARISTON_EMAIL
```

Alternatively, in the Cloudflare dashboard, open **Workers & Pages**, select `sasw-energy-worker`, then go to **Settings > Variables and Secrets** and add each credential as a secret. Cloudflare stores secret values for the Worker; they are not ordinary Git-tracked configuration and cannot be read back in plaintext from the dashboard.

In Worker code, secrets and ordinary variables are both read from `env`, using the same binding names, such as `env.DEYE_APP_SECRET`. Keep TypeScript's `Env` type in sync with the names your code reads (or regenerate types with `npx wrangler types`).

### GitHub Actions deployment credentials

The repository's GitHub Actions deployment workflow uses `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` to authorize deployment. These are deployment credentials and belong in the GitHub repository's **Settings > Secrets and variables > Actions**.

The Deye and Ariston credentials are for the running Worker, so add them to Cloudflare as Worker secrets. You do not need to add them to GitHub Actions for the current workflow: the workflow deploys the Worker, while the Worker reads its production secrets from Cloudflare at runtime. If you later change the workflow to provision Worker secrets automatically, then it would need access to their values in GitHub Actions.

## Scheduled energy check

Cloudflare Cron Triggers invoke the `scheduled()` handler; they do not require an HTTP request to wake the Worker. This project configures a trigger every 15 minutes from 06:00 through 21:45 UTC in `wrangler.jsonc`:

```jsonc
"triggers": {
  "crons": ["*/15 6-21 * * *"]
}
```

Cron expressions use UTC, while the desired operating window is 08:00 to 22:00 in Europe/Madrid. The scheduled handler checks Madrid local time and skips outside that window. The broad UTC range covers both summer and winter time; around the window edges, a few scheduled invocations can occur without making API calls. Manual checks can run at any hour.

During an active run, the Worker:

1. Gets a fresh Deye access token using the configured app ID, secret, email, and SHA-256 password digest. It sends the token as `Authorization: Bearer <token>` to `POST /v1.0/station/latest` with the station ID.
2. Gets a fresh Ariston token and sends it in the `ar.authToken` header to the Bruno `medPlantData//<gateway>` endpoint. Both systems are read on each daytime run.
3. If Ariston `temp` is at or above its live `reqTemp`, posts the JSON boolean `true` to `medPlantData/<gateway>/switchEco`. This safeguard takes priority over solar checks, even if Deye is unavailable or production is low. If Eco is already on, no POST is needed.
4. Otherwise, computes net surplus as Deye `generationPower - consumptionPower`. It skips at 500 W or less; surplus must be strictly greater than 500 W.
5. It then skips when `batterySOC` is 95% or less, when water is at or above `reqTemp`, or when Eco is off. Manual-mode switching is limited to 09:00–19:00 Europe/Madrid. Within that window, only when surplus is above 500 W, battery charge is above 95%, water is below `reqTemp`, and Eco is on does it post `{"new":1}` to `medPlantData/<gateway>/mode`.

Tokens are requested afresh on each run and are never cached. Invalid or unavailable readings prevent the manual-mode change; a valid Ariston reading can still trigger the `reqTemp` Eco rule if Deye fails. Each invocation logs one `energy-check` entry with the available readings and a `skipped`, `dry_run`, `changed`, or `failed` outcome. Tokens, passwords, and full upstream responses are not logged.

## Manual check and results

Open [the protected website](https://sasw-energy-worker.coderiff.workers.dev/) and sign in through [Cloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/). **Latest check** shows the most recent completed run from either the scheduled cron or the **Check now** button. It includes generation, consumption, net surplus, battery charge, water temperature, requested temperature, Eco state, the decision, and thresholds: `reqTemp`, >500 W net surplus, >95% battery, water below `reqTemp`, and 09:00–19:00 Europe/Madrid for manual mode. A cron invocation skipped outside daytime hours, or a request declined because another run is active or the cooldown has not passed, does not replace the latest completed result. Click **Check now** to request a run immediately. The page calls `POST /check`; visiting or refreshing the page only reads `GET /status` and does not contact Deye or Ariston. The POST requires a same-origin browser request, in addition to Access authentication. The page stores no API tokens.

One SQLite-backed Durable Object coordinates scheduled and manual checks. It allows one run at a time and starts a 10-minute cooldown when a run begins. A request during a run or cooldown is skipped before either remote API is contacted. The last completed result and last start time are stored there, so a page refresh or Worker restart does not erase them. A manual check can cause the next scheduled check to skip due to the shared cooldown. The logs still record each scheduled skip.

If Access is disabled for this Worker, the manual endpoint becomes reachable without the intended sign-in. Verify **All traffic** is protected in **Workers & Pages > your Worker > Access**. The scheduled trigger continues independently of browser authentication.

## Local test plan

1. Run `npm test -- --run`. These tests mock both remote APIs and check the decision boundaries, the Eco override, the page response, and the outbound request shapes without touching a real device.
2. Fill `.dev.vars` with your local values, including the SHA-256 Deye password digest. Leave `DRY_RUN=true`.
3. Run `npm run dev` and open `GET /`. Confirm the status page loads. Access is applied to the deployed Worker, so the local page itself has no Cloudflare sign-in.
4. Open Wrangler's Local Explorer and invoke the scheduled handler with a time inside 08:00–22:00 Europe/Madrid. Local development does not automatically fire Cron Triggers. Review the `energy-check` log: it should show the readings and a skip reason, `would_set_mode_1`, or `would_enable_eco`.
5. Invoke it with a time outside the window and confirm the `outside_day_hours` log appears without API calls. Use the Bruno requests to compare the Deye and Ariston readings if an upstream call fails. Scheduled runs use the same 10-minute cooldown as manual runs, so allow time between these checks.
6. Use **Check now** with `DRY_RUN=true` and confirm the page shows the result. Repeating within 10 minutes should be declined without another upstream request. Only when you deliberately want to verify a live mode change, set `DRY_RUN=false`, run during qualifying conditions, and confirm the `changed` log and the heater's state.

The Local Explorer can also invoke a scheduled handler through `/cdn-cgi/local/scheduled`, but its time picker is more useful for checking both sides of the Madrid time window. In production, inspect the Worker's **Observability > Logs** view for the same `energy-check` entries.

## Deploy

Deploy from your local machine with:

```sh
npm run deploy
```

The GitHub Actions workflow also deploys on pushes to `main` and can be run manually. Configure its Cloudflare API token and account ID in GitHub Actions secrets as described above.

## References

- [Cloudflare Workers: Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Workers: Environment variables](https://developers.cloudflare.com/workers/configuration/environment-variables/)
- [Cloudflare Workers: Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare Workers: Scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
