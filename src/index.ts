interface WorkerEnv {
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
  batterySOC?: number;
  temperature?: number;
  eco?: boolean;
};

type DeyeReading = { generationPower: number; batterySOC: number };
type AristonReading = {
  temperature: number;
  eco: boolean;
  token: string;
  gateway: string;
};

const DEYE_API = "https://eu1-developer.deyecloud.com/v1.0";
const ARISTON_API = "https://www.ariston-net.remotethermo.com/api/v2";
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
  scheduledTime: number,
  readings: Readings,
  outcome: "skipped" | "changed" | "dry_run" | "failed",
  reason: string,
  status?: number,
): void {
  console.log("energy-check", {
    scheduledAt: new Date(scheduledTime).toISOString(),
    ...readings,
    outcome,
    reason,
    ...(status === undefined ? {} : { status }),
  });
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
  const batterySOC = numberField(latest, "batterySOC", "deye_latest");
  if (generationPower < 0 || batterySOC < 0 || batterySOC > 100)
    throw new StepError("deye_latest");
  return { generationPower, batterySOC };
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
  if (temperature < 0 || temperature > 100)
    throw new StepError("ariston_reading");
  return {
    temperature: temperature,
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

async function runEnergyCheck(
  scheduledTime: number,
  env: WorkerEnv,
): Promise<void> {
  const readings: Readings = {};
  const localHour = Number(MADRID_HOUR.format(new Date(scheduledTime)));
  if (localHour < 8 || localHour >= 22) {
    logResult(scheduledTime, readings, "skipped", "outside_day_hours");
    return;
  }

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
    readings.eco = ariston.eco;

    if (ariston.temperature >= 72) {
      if (ariston.eco) {
        logResult(scheduledTime, readings, "skipped", "already_eco_at_72c");
        return;
      }
      if (env.DRY_RUN === "true") {
        logResult(scheduledTime, readings, "dry_run", "would_enable_eco");
        return;
      }
      await setAriston(ariston, "switchEco");
      logResult(scheduledTime, readings, "changed", "enabled_eco");
      return;
    }

    if (deyeResult.status === "rejected") throw deyeResult.reason;
    const deye = deyeResult.value;
    if (deye.generationPower <= 1500) {
      logResult(scheduledTime, readings, "skipped", "solar_at_or_below_1500w");
      return;
    }
    // The 90-95% gap is intentionally conservative: only above 95% can act.
    if (deye.batterySOC <= 95) {
      logResult(
        scheduledTime,
        readings,
        "skipped",
        "battery_at_or_below_95pct",
      );
      return;
    }
    if (ariston.temperature >= 64) {
      logResult(scheduledTime, readings, "skipped", "water_at_or_above_64c");
      return;
    }
    if (!ariston.eco) {
      logResult(scheduledTime, readings, "skipped", "eco_disabled");
      return;
    }
    if (env.DRY_RUN === "true") {
      logResult(scheduledTime, readings, "dry_run", "would_set_mode_1");
      return;
    }
    await setAriston(ariston, "mode");
    logResult(scheduledTime, readings, "changed", "set_mode_1");
  } catch (error) {
    const failure =
      error instanceof StepError ? error : new StepError("unexpected");
    logResult(scheduledTime, readings, "failed", failure.stage, failure.status);
    throw failure;
  }
}

export default {
  fetch(request: Request): Response {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    return new Response("Hello World!");
  },
  scheduled(controller: ScheduledController, env: WorkerEnv): Promise<void> {
    return runEnergyCheck(controller.scheduledTime, env);
  },
} satisfies ExportedHandler<WorkerEnv>;
