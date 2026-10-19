import {
	env,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("status page", () => {
	it("serves the manual check button (unit style)", async () => {
		const request = new IncomingRequest("http://example.com");
		const response = await worker.fetch(request, env);
		expect(await response.text()).toContain("Check now");
	});

	it("serves the manual check button (integration style)", async () => {
		const response = await SELF.fetch("https://example.com");
		expect(await response.text()).toContain("Check now");
	});
});
