import { DurableObject } from "cloudflare:workers";
import { STATUS_PAGE } from "./status-page";

interface WorkerEnv {
  ENERGY_RUNNER: DurableObjectNamespace<EnergyRunner>;
  DEYE_APP_ID: string;
  DEYE_APP_SECRET: string;
  DEYE_EMAIL: string;
  DEYE_PASSWORD: string; // SHA-256 digest, as in the Bruno collection
  DEYE_STATION_ID: string;
  ARISTON_EMAIL: string;
  ARISTON_PASSWORD: string;
  ARISTON_GATEWAY: string;
  DRY_RUN?: string;
}

type Readings = {
  generationPower?: number;
  consumptionPower?: number;
  netSurplus?: number;
  batterySOC?: number;
  temperature?: number;
  reqTemp?: number;
  eco?: boolean;
};

type CheckResult = Readings & {
  checkedAt: string;
  source: "scheduled" | "manual";
  outcome: "skipped" | "changed" | "dry_run" | "failed";
  reason: string;
  thresholds: {
    ecoAtReqTemp: true;
    netSurplusAboveW: number;
    batterySOCAbovePercent: number;
    manualModeBelowReqTemp: true;
    manualModeStartHourMadrid: number;
    manualModeEndHourMadridExclusive: number;
  };
  status?: number;
};

type RunnerStatus = {
  running: boolean;
  nextAllowedAt: string | null;
  lastResult: CheckResult | null;
};

type RunResponse =
  | { accepted: true; result: CheckResult; status: RunnerStatus }
  | { accepted: false; reason: "already_running" | "cooldown"; status: RunnerStatus };

type DeyeReading = { generationPower: number; consumptionPower: number; batterySOC: number };
type AristonReading = {
  temperature: number;
  reqTemp: number;
  eco: boolean;
  token: string;
  gateway: string;
};

const DEYE_API = "https://eu1-developer.deyecloud.com/v1.0";
const ARISTON_API = "https://www.ariston-net.remotethermo.com/api/v2";
const COOLDOWN_MS = 10 * 60 * 1000;
const NET_SURPLUS_THRESHOLD_W = 500;
const BATTERY_SOC_THRESHOLD = 95;
const MANUAL_MODE_START_HOUR_MADRID = 9;
const MANUAL_MODE_END_HOUR_MADRID_EXCLUSIVE = 19;
const MADRID_HOUR = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Madrid",
  hour: "2-digit",
  hourCycle: "h23",
});

class StepError extends Error {
  constructor(
    readonly stage: string,
    readonly status?: number,
  ) {
    super(`Energy check failed at ${stage}`);
  }
}

function logResult(
  checkedTime: number,
  source: CheckResult["source"],
  readings: Readings,
  outcome: CheckResult["outcome"],
  reason: string,
  status?: number,
): CheckResult {
  const result: CheckResult = {
    checkedAt: new Date(checkedTime).toISOString(),
    source,
    ...readings,
    thresholds: {
      ecoAtReqTemp: true,
      netSurplusAboveW: NET_SURPLUS_THRESHOLD_W,
      batterySOCAbovePercent: BATTERY_SOC_THRESHOLD,
      manualModeBelowReqTemp: true,
      manualModeStartHourMadrid: MANUAL_MODE_START_HOUR_MADRID,
      manualModeEndHourMadridExclusive: MANUAL_MODE_END_HOUR_MADRID_EXCLUSIVE,
    },
    outcome,
    reason,
    ...(status === undefined ? {} : { status }),
  };
  console.log("energy-check", result);
  return result;
}

function requireValues(
  env: WorkerEnv,
  names: (keyof WorkerEnv)[],
  stage: string,
): void {
  if (names.some((name) => !env[name])) throw new StepError(stage);
}

async function requestJson(
  url: string,
  init: RequestInit,
  stage: string,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new StepError(stage);
  }
  if (!response.ok) throw new StepError(stage, response.status);
  try {
    const data: unknown = await response.json();
    if (data !== null && typeof data === "object" && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
  } catch {
    // The caller receives a safe error without response bodies or credentials.
  }
  throw new StepError(stage);
}

function textField(
  data: Record<string, unknown>,
  name: string,
  stage: string,
): string {
  const value = data[name];
  if (typeof value !== "string" || !value.trim()) throw new StepError(stage);
  return value;
}

function numberField(
  data: Record<string, unknown>,
  name: string,
  stage: string,
): number {
  const value = data[name];
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new StepError(stage);
  return value;
}

async function getDeyeReading(env: WorkerEnv): Promise<DeyeReading> {
  requireValues(
    env,
    [
      "DEYE_APP_ID",
      "DEYE_APP_SECRET",
      "DEYE_EMAIL",
      "DEYE_PASSWORD",
      "DEYE_STATION_ID",
    ],
    "deye_configuration",
  );
  if (!/^[0-9a-f]{64}$/i.test(env.DEYE_PASSWORD))
    throw new StepError("deye_configuration");

  const tokenUrl = new URL(`${DEYE_API}/account/token`);
  tokenUrl.searchParams.set("appId", env.DEYE_APP_ID);
  const auth = await requestJson(
    tokenUrl.toString(),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appSecret: env.DEYE_APP_SECRET,
        email: env.DEYE_EMAIL,
        password: env.DEYE_PASSWORD,
      }),
    },
    "deye_auth",
  );
  if (auth.success === false) throw new StepError("deye_auth");
  const token = textField(auth, "accessToken", "deye_auth");

  const latest = await requestJson(
    `${DEYE_API}/station/latest`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ stationId: env.DEYE_STATION_ID }),
    },
    "deye_latest",
  );
  if (latest.success !== true) throw new StepError("deye_latest");
  const generationPower = numberField(latest, "generationPower", "deye_latest");
  const consumptionPower = numberField(latest, "consumptionPower", "deye_latest");
  const batterySOC = numberField(latest, "batterySOC", "deye_latest");
  if (generationPower < 0 || consumptionPower < 0 || batterySOC < 0 || batterySOC > 100)
    throw new StepError("deye_latest");
  return { generationPower, consumptionPower, batterySOC };
}

async function getAristonReading(env: WorkerEnv): Promise<AristonReading> {
  requireValues(
    env,
    ["ARISTON_EMAIL", "ARISTON_PASSWORD", "ARISTON_GATEWAY"],
    "ariston_configuration",
  );
  const auth = await requestJson(
    `${ARISTON_API}/accounts/login`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        usr: env.ARISTON_EMAIL,
        pwd: env.ARISTON_PASSWORD,
      }),
    },
    "ariston_auth",
  );
  const token = textField(auth, "token", "ariston_auth");
  const gateway = encodeURIComponent(env.ARISTON_GATEWAY);
  const thermo = await requestJson(
    `${ARISTON_API}/velis/medPlantData//${gateway}`,
    { method: "GET", headers: { "ar.authToken": token } },
    "ariston_reading",
  );
  if (typeof thermo.eco !== "boolean") throw new StepError("ariston_reading");
  const temperature = numberField(thermo, "temp", "ariston_reading");
  const reqTemp = numberField(thermo, "reqTemp", "ariston_reading");
  if (temperature < 0 || temperature > 100 || reqTemp < 0 || reqTemp > 100)
    throw new StepError("ariston_reading");
  return {
    temperature: temperature,
    reqTemp,
    eco: thermo.eco,
    token,
    gateway,
  };
}

async function setAriston(
  ariston: AristonReading,
  action: "mode" | "switchEco",
): Promise<void> {
  const stage = action === "mode" ? "ariston_mode" : "ariston_eco";
  let response: Response;
  try {
    response = await fetch(
      `${ARISTON_API}/velis/medPlantData/${ariston.gateway}/${action}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "ar.authToken": ariston.token,
        },
        body: JSON.stringify(action === "mode" ? { new: 1 } : true),
      },
    );
  } catch {
    throw new StepError(stage);
  }
  if (!response.ok) throw new StepError(stage, response.status);
}

export async function runEnergyCheck(
  checkedTime: number,
  env: WorkerEnv,
  source: CheckResult["source"],
): Promise<CheckResult> {
  const readings: Readings = {};

  try {
    // Read both systems on every daytime run. An Ariston overheat response can
    // still run when Deye is unavailable or production is low.
    const [deyeResult, aristonResult] = await Promise.allSettled([
      getDeyeReading(env),
      getAristonReading(env),
    ]);
    if (deyeResult.status === "fulfilled")
      Object.assign(readings, deyeResult.value);
    if (aristonResult.status === "rejected") throw aristonResult.reason;
    const ariston = aristonResult.value;
    readings.temperature = ariston.temperature;
    readings.reqTemp = ariston.reqTemp;
    readings.eco = ariston.eco;

    if (ariston.temperature >= ariston.reqTemp) {
      if (ariston.eco) {
        return logResult(checkedTime, source, readings, "skipped", "already_eco_at_req_temp");
      }
      if (env.DRY_RUN === "true") {
        return logResult(checkedTime, source, readings, "dry_run", "would_enable_eco");
      }
      await setAriston(ariston, "switchEco");
      return logResult(checkedTime, source, readings, "changed", "enabled_eco");
    }

    if (deyeResult.status === "rejected") throw deyeResult.reason;
    const deye = deyeResult.value;
    const netSurplus = deye.generationPower - deye.consumptionPower;
    readings.netSurplus = netSurplus;
    if (netSurplus <= NET_SURPLUS_THRESHOLD_W) {
      return logResult(checkedTime, source, readings, "skipped", "net_surplus_at_or_below_500w");
    }
    // The 90-95% gap is intentionally conservative: only above 95% can act.
    if (deye.batterySOC <= BATTERY_SOC_THRESHOLD) {
      return logResult(
        checkedTime,
        source,
        readings,
        "skipped",
        "battery_at_or_below_95pct",
      );
    }
    if (ariston.temperature >= ariston.reqTemp) {
      return logResult(checkedTime, source, readings, "skipped", "water_at_or_above_req_temp");
    }
    const madridHour = Number(MADRID_HOUR.format(new Date(checkedTime)));
    if (
      madridHour < MANUAL_MODE_START_HOUR_MADRID ||
      madridHour >= MANUAL_MODE_END_HOUR_MADRID_EXCLUSIVE
    ) {
      return logResult(checkedTime, source, readings, "skipped", "outside_manual_mode_hours");
    }
    if (!ariston.eco) {
      return logResult(checkedTime, source, readings, "skipped", "eco_disabled");
    }
    if (env.DRY_RUN === "true") {
      return logResult(checkedTime, source, readings, "dry_run", "would_set_mode_1");
    }
    await setAriston(ariston, "mode");
    return logResult(checkedTime, source, readings, "changed", "set_mode_1");
  } catch (error) {
    const failure =
      error instanceof StepError ? error : new StepError("unexpected");
    return logResult(checkedTime, source, readings, "failed", failure.stage, failure.status);
  }
}

export class EnergyRunner extends DurableObject<WorkerEnv> {
  private running = false;

  async getStatus(): Promise<RunnerStatus> {
    const [lastStarted, lastResult] = await Promise.all([
      this.ctx.storage.get<number>("lastStarted"),
      this.ctx.storage.get<CheckResult>("lastResult"),
    ]);
    return {
      running: this.running,
      nextAllowedAt: lastStarted && lastStarted + COOLDOWN_MS > Date.now()
        ? new Date(lastStarted + COOLDOWN_MS).toISOString()
        : null,
      lastResult: lastResult ?? null,
    };
  }

  async run(source: CheckResult["source"], checkedTime: number): Promise<RunResponse> {
    if (this.running) {
      return { accepted: false, reason: "already_running", status: await this.getStatus() };
    }

    // Set the in-memory lock before the first await, so RPC calls cannot start together.
    this.running = true;
    try {
      const lastStarted = await this.ctx.storage.get<number>("lastStarted");
      if (lastStarted && Date.now() - lastStarted < COOLDOWN_MS) {
        this.running = false;
        return { accepted: false, reason: "cooldown", status: await this.getStatus() };
      }

      // Persist the start first. A restart after an upstream call cannot immediately repeat it.
      await this.ctx.storage.put("lastStarted", Date.now());
      const result = await runEnergyCheck(checkedTime, this.env, source);
      await this.ctx.storage.put("lastResult", result);
      this.running = false;
      return { accepted: true, result, status: await this.getStatus() };
    } finally {
      this.running = false;
    }
  }
}

function runner(env: WorkerEnv): DurableObjectStub<EnergyRunner> {
  return env.ENERGY_RUNNER.getByName("home-energy");
}

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(STATUS_PAGE, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'",
        },
      });
    }
    if (url.pathname === "/status" && request.method === "GET") {
      return jsonResponse(await runner(env).getStatus());
    }
    if (url.pathname === "/check" && request.method === "POST") {
      if (request.headers.get("Origin") !== url.origin) {
        return jsonResponse({ error: "invalid_origin" }, 403);
      }
      const response = await runner(env).run("manual", Date.now());
      return jsonResponse(response, response.accepted ? 200 : 429);
    }
    return new Response("Not Found", { status: 404 });
  },
  async scheduled(controller: ScheduledController, env: WorkerEnv): Promise<void> {
    const localHour = Number(MADRID_HOUR.format(new Date(controller.scheduledTime)));
    if (localHour < 8 || localHour >= 22) {
      logResult(controller.scheduledTime, "scheduled", {}, "skipped", "outside_day_hours");
      return;
    }
    const response = await runner(env).run("scheduled", controller.scheduledTime);
    if (!response.accepted) {
      logResult(controller.scheduledTime, "scheduled", {}, "skipped", response.reason);
    } else if (response.result.outcome === "failed") {
      throw new Error(`Energy check failed at ${response.result.reason}`);
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
