import { afterEach, describe, expect, it, vi } from 'vitest';
import { runEnergyCheck } from '../src/index';

const activeTime = Date.UTC(2026, 0, 15, 12, 0); // 13:00 in Madrid
const env = {
	DEYE_APP_ID: 'app',
	DEYE_APP_SECRET: 'app-secret',
	DEYE_EMAIL: 'deye@example.com',
	DEYE_PASSWORD: 'a'.repeat(64),
	DEYE_STATION_ID: 'station',
	ARISTON_EMAIL: 'ariston@example.com',
	ARISTON_PASSWORD: 'password',
	ARISTON_GATEWAY: 'gateway',
};

type Call = { url: string; init: RequestInit };

function mockApis(
	generationPower: number,
	batterySOC: number,
	temperature: number,
	eco: boolean,
	deyeFails = false,
	consumptionPower = 0,
	reqTemp = 67,
): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			if (url.includes('/account/token')) return Response.json({ success: true, accessToken: 'deye-token' });
			if (url.endsWith('/station/latest')) {
				if (deyeFails) return Response.json({ error: 'unavailable' }, { status: 502 });
				return Response.json({ success: true, generationPower, consumptionPower, batterySOC });
			}
			if (url.endsWith('/accounts/login')) return Response.json({ token: 'ariston-token' });
			if (url.endsWith('/medPlantData//gateway')) return Response.json({ temp: temperature, reqTemp, eco });
			if (url.endsWith('/switchEco') || url.endsWith('/mode')) return Response.json({ ok: true });
			throw new Error(`Unexpected request: ${url}`);
		}),
	);
	return calls;
}

async function run(scheduledTime = activeTime, overrides: { DRY_RUN?: string } = {}): Promise<void> {
	await runEnergyCheck(scheduledTime, { ...env, ...overrides } as Parameters<typeof runEnergyCheck>[1], 'scheduled');
}

afterEach(() => vi.unstubAllGlobals());

describe('scheduled energy check', () => {
	it('enables Eco at reqTemp even when solar production is low', async () => {
		const calls = mockApis(520, 87, 67, false);
		await run();
		const ecoPost = calls.find((call) => call.url.endsWith('/switchEco'));
		expect(ecoPost?.init.method).toBe('POST');
		expect(ecoPost?.init.body).toBe('true');
		expect(ecoPost?.init.headers).toMatchObject({ 'ar.authToken': 'ariston-token' });
		expect(calls.some((call) => call.url.endsWith('/mode'))).toBe(false);
	});

	it('enables Eco at reqTemp even when Deye is unavailable', async () => {
		const calls = mockApis(0, 0, 72, false, true);
		await run();
		expect(calls.some((call) => call.url.endsWith('/switchEco'))).toBe(true);
	});

	it('does not repeat the Eco request when Eco is already on', async () => {
		const calls = mockApis(1501, 96, 72, true);
		await run();
		expect(calls.some((call) => call.url.endsWith('/switchEco') || call.url.endsWith('/mode'))).toBe(false);
	});

	it('sets manual mode only when net surplus and water conditions qualify', async () => {
		const calls = mockApis(1501, 96, 63, true, false, 900);
		await run();
		const modePost = calls.find((call) => call.url.endsWith('/mode'));
		expect(modePost?.init.method).toBe('POST');
		expect(modePost?.init.body).toBe('{"new":1}');
		expect(modePost?.init.headers).toMatchObject({ 'ar.authToken': 'ariston-token' });
		const station = calls.find((call) => call.url.endsWith('/station/latest'));
		expect(station?.init.headers).toMatchObject({ Authorization: 'Bearer deye-token' });
		const auth = calls.find((call) => call.url.includes('/account/token'));
		expect(JSON.parse(String(auth?.init.body)).password).toBe(env.DEYE_PASSWORD);
	});

	it.each([
		[1000, 96, 63, true, 500],
		[1501, 95, 63, true],
		[1501, 96, 67, true],
		[1501, 96, 63, false],
	])('does not change the heater for conservative boundary conditions', async (power, soc, temp, eco, consumption = 0) => {
		const calls = mockApis(power, soc, temp, eco, false, consumption);
		await run();
		expect(calls.some((call) => call.url.endsWith('/mode') || call.url.endsWith('/switchEco'))).toBe(false);
	});

	it('keeps a dry run read only', async () => {
		const calls = mockApis(520, 87, 72, false);
		await run(activeTime, { DRY_RUN: 'true' });
		expect(calls.some((call) => call.url.endsWith('/mode') || call.url.endsWith('/switchEco'))).toBe(false);
	});

});
