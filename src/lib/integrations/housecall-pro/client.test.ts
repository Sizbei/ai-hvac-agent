import { describe, it, expect, vi, afterEach } from "vitest";
import {
  RestHousecallProClient,
  getHousecallClient,
} from "./client";
import type { HousecallConfig } from "./config";

const CONFIG: HousecallConfig = {
  apiKey: "hcp-test-key",
  baseUrl: "https://api.housecallpro.test",
};

/** Build a fake Response with a controllable body/status. */
function res(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RestHousecallProClient — auth + request shaping", () => {
  it("sends the API key as a Token header and never in the URL/body", async () => {
    const fetchMock = vi.fn<(url?: string, init?: RequestInit) => Promise<Response>>(async () => res({ id: "cust-1" }));
    const client = new RestHousecallProClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    await client.createCustomer({ firstName: "Jane", lastName: "Doe" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.housecallpro.test/customers");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe("Token hcp-test-key");
    expect(headers.accept).toBe("application/json");
    // The key never leaks into the URL or the request body.
    expect(url as string).not.toContain("hcp-test-key");
    expect((init as RequestInit).body as string).not.toContain("hcp-test-key");
  });

  it("maps createCustomer input to HCP field names", async () => {
    const fetchMock = vi.fn<(url?: string, init?: RequestInit) => Promise<Response>>(async () => res({ id: "cust-1" }));
    const client = new RestHousecallProClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    await client.createCustomer({
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      mobileNumber: "+15551234567",
      address: { street: "1 Main St", city: "Boston", state: "MA", zip: "02101" },
    });

    const sent = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sent.first_name).toBe("Jane");
    expect(sent.last_name).toBe("Doe");
    expect(sent.email).toBe("jane@example.com");
    expect(sent.mobile_number).toBe("+15551234567");
    expect(sent.addresses).toHaveLength(1);
    expect(sent.addresses[0].city).toBe("Boston");
  });

  it("createCustomer narrows the HCP response to our typed customer", async () => {
    const fetchMock = vi.fn<(url?: string, init?: RequestInit) => Promise<Response>>(async () =>
      res({
        id: "cust-99",
        first_name: "Jane",
        last_name: "Doe",
        email: "jane@example.com",
        mobile_number: null,
        home_number: null,
        company: null,
        addresses: [{ city: "Boston" }],
      }),
    );
    const client = new RestHousecallProClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    const customer = await client.createCustomer({
      firstName: "Jane",
      lastName: "Doe",
    });
    expect(customer.id).toBe("cust-99");
    expect(customer.email).toBe("jane@example.com");
    expect(customer.addresses[0]?.city).toBe("Boston");
  });
});

describe("RestHousecallProClient.findCustomer", () => {
  it("queries by contact term and returns the first match", async () => {
    const fetchMock = vi.fn<(url?: string, init?: RequestInit) => Promise<Response>>(async () =>
      res({ customers: [{ id: "cust-7", email: "j@x.com" }] }),
    );
    const client = new RestHousecallProClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    const found = await client.findCustomer({ email: "j@x.com" });

    expect(found?.id).toBe("cust-7");
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/customers?");
    expect(url).toContain("q=j%40x.com");
  });

  it("returns null when no contact term is provided (no API call)", async () => {
    const fetchMock = vi.fn();
    const client = new RestHousecallProClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    expect(await client.findCustomer({})).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when HCP returns an empty list", async () => {
    const fetchMock = vi.fn<(url?: string, init?: RequestInit) => Promise<Response>>(async () => res({ customers: [] }));
    const client = new RestHousecallProClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    expect(await client.findCustomer({ phone: "+15551234567" })).toBeNull();
  });
});

describe("RestHousecallProClient.createJob", () => {
  it("maps job input (schedule + request tag) to HCP fields", async () => {
    const fetchMock = vi.fn<(url?: string, init?: RequestInit) => Promise<Response>>(async () =>
      res({ id: "job-1", customer_id: "cust-1", work_status: "scheduled" }),
    );
    const client = new RestHousecallProClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    const job = await client.createJob({
      customerId: "cust-1",
      description: "No cooling",
      scheduleStart: "2026-07-01T12:00:00.000Z",
      scheduleEnd: "2026-07-01T16:00:00.000Z",
      requestId: "req-42",
    });

    expect(job.id).toBe("job-1");
    expect(job.work_status).toBe("scheduled");
    const sent = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sent.customer_id).toBe("cust-1");
    expect(sent.schedule.start_time).toBe("2026-07-01T12:00:00.000Z");
    expect(sent.tags).toContain("request:req-42");
  });

  it("serializes lineItems into HCP line_items (kind/quantity, NO price)", async () => {
    const fetchMock = vi.fn<(url?: string, init?: RequestInit) => Promise<Response>>(async () =>
      res({ id: "job-1", customer_id: "cust-1", work_status: "scheduled" }),
    );
    const client = new RestHousecallProClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    await client.createJob({
      customerId: "cust-1",
      description: "No cooling",
      lineItems: [
        { name: "No Cool — No cooling", kind: "service", quantity: 1 },
        { name: "Site access", kind: "labor", quantity: 1, description: "Gate 1234" },
      ],
    });

    const sent = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sent.line_items).toHaveLength(2);
    expect(sent.line_items[0]).toMatchObject({
      name: "No Cool — No cooling",
      kind: "service",
      quantity: 1,
    });
    expect(sent.line_items[1].description).toBe("Gate 1234");
    // No price is ever serialized for our descriptive items.
    for (const li of sent.line_items) {
      expect(li.unit_price).toBeUndefined();
    }
  });

  it("omits line_items when no lineItems are provided", async () => {
    const fetchMock = vi.fn<(url?: string, init?: RequestInit) => Promise<Response>>(async () =>
      res({ id: "job-1", customer_id: "cust-1", work_status: "scheduled" }),
    );
    const client = new RestHousecallProClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    await client.createJob({ customerId: "cust-1", description: "No cooling" });
    const sent = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sent.line_items).toBeUndefined();
  });

  it("omits schedule for an unscheduled job", async () => {
    const fetchMock = vi.fn<(url?: string, init?: RequestInit) => Promise<Response>>(async () =>
      res({ id: "job-2", customer_id: "cust-1", work_status: "unscheduled" }),
    );
    const client = new RestHousecallProClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    await client.createJob({ customerId: "cust-1", description: "Estimate" });
    const sent = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sent.schedule).toBeUndefined();
  });
});

describe("RestHousecallProClient.updateJob", () => {
  it("PUTs the job id with the new schedule + description", async () => {
    const fetchMock = vi.fn<(url?: string, init?: RequestInit) => Promise<Response>>(async () =>
      res({ id: "job-9", customer_id: "cust-1", work_status: "scheduled" }),
    );
    const client = new RestHousecallProClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    const job = await client.updateJob("job-9", {
      description: "Rescheduled — no cooling",
      scheduleStart: "2026-07-02T12:00:00.000Z",
      scheduleEnd: "2026-07-02T16:00:00.000Z",
    });

    expect(job.id).toBe("job-9");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.housecallpro.test/jobs/job-9");
    expect((init as RequestInit).method).toBe("PUT");
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.description).toBe("Rescheduled — no cooling");
    expect(sent.schedule.start_time).toBe("2026-07-02T12:00:00.000Z");
    expect(sent.schedule.end_time).toBe("2026-07-02T16:00:00.000Z");
  });

  it("serializes lineItems into HCP line_items on update (NO price)", async () => {
    const fetchMock = vi.fn<(url?: string, init?: RequestInit) => Promise<Response>>(async () =>
      res({ id: "job-9", customer_id: "cust-1", work_status: "scheduled" }),
    );
    const client = new RestHousecallProClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    await client.updateJob("job-9", {
      description: "Updated",
      lineItems: [{ name: "Central Ac service", kind: "service", quantity: 1 }],
    });
    const sent = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sent.line_items).toHaveLength(1);
    expect(sent.line_items[0].name).toBe("Central Ac service");
    expect(sent.line_items[0].unit_price).toBeUndefined();
  });

  it("omits line_items on an update that carries none", async () => {
    const fetchMock = vi.fn<(url?: string, init?: RequestInit) => Promise<Response>>(async () =>
      res({ id: "job-9", customer_id: "cust-1", work_status: "scheduled" }),
    );
    const client = new RestHousecallProClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    await client.updateJob("job-9", { description: "Updated notes" });
    const sent = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sent.line_items).toBeUndefined();
  });

  it("omits schedule on a description-only update (does not blank the window)", async () => {
    const fetchMock = vi.fn<(url?: string, init?: RequestInit) => Promise<Response>>(async () =>
      res({ id: "job-9", customer_id: "cust-1", work_status: "scheduled" }),
    );
    const client = new RestHousecallProClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    await client.updateJob("job-9", { description: "Updated notes" });
    const sent = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sent.schedule).toBeUndefined();
  });
});

describe("RestHousecallProClient.cancelJob", () => {
  it("PUTs the cancel endpoint and resolves void", async () => {
    const fetchMock = vi.fn<(url?: string, init?: RequestInit) => Promise<Response>>(async () =>
      res(null, true, 204),
    );
    const client = new RestHousecallProClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    await expect(client.cancelJob("job-9")).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.housecallpro.test/jobs/job-9/cancel");
    expect((init as RequestInit).method).toBe("PUT");
  });
});

describe("RestHousecallProClient.getJob", () => {
  it("flattens HCP schedule.start_time/end_time onto the job", async () => {
    const fetchMock = vi.fn<(url?: string, init?: RequestInit) => Promise<Response>>(async () =>
      res({
        id: "job-3",
        customer_id: "cust-1",
        work_status: "completed",
        description: "Fixed",
        schedule: {
          start_time: "2026-07-01T12:00:00.000Z",
          end_time: "2026-07-01T16:00:00.000Z",
        },
      }),
    );
    const client = new RestHousecallProClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    const job = await client.getJob("job-3");
    expect(job.schedule_start).toBe("2026-07-01T12:00:00.000Z");
    expect(job.schedule_end).toBe("2026-07-01T16:00:00.000Z");
  });
});

describe("RestHousecallProClient.listAvailability", () => {
  it("normalizes HCP slots to UTC [startIso,endIso) windows", async () => {
    const fetchMock = vi.fn<(url?: string, init?: RequestInit) => Promise<Response>>(async () =>
      res({
        availability: [
          {
            start_time: "2026-07-01T12:00:00.000Z",
            end_time: "2026-07-01T16:00:00.000Z",
          },
          { start_time: "bad" }, // malformed slot dropped
        ],
      }),
    );
    const client = new RestHousecallProClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    const slots = await client.listAvailability({
      startIso: "2026-07-01T00:00:00.000Z",
      endIso: "2026-07-02T00:00:00.000Z",
    });
    expect(slots).toHaveLength(1);
    expect(slots[0]).toEqual({
      startIso: "2026-07-01T12:00:00.000Z",
      endIso: "2026-07-01T16:00:00.000Z",
    });
  });
});

describe("RestHousecallProClient.listTechnicians", () => {
  it("GETs the employees endpoint with the Token auth header", async () => {
    const fetchMock = vi.fn<(url?: string, init?: RequestInit) => Promise<Response>>(async () =>
      res({ employees: [{ id: "emp-1", first_name: "Pat", active: true }] }),
    );
    const client = new RestHousecallProClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    const techs = await client.listTechnicians();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.housecallpro.test/employees");
    expect((init as RequestInit).method).toBe("GET");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe("Token hcp-test-key");
    expect(techs).toHaveLength(1);
    expect(techs[0]).toEqual({ id: "emp-1", name: "Pat", isActive: true });
  });

  it("assembles name from first_name/last_name and reads is_active fallback", async () => {
    const fetchMock = vi.fn<(url?: string, init?: RequestInit) => Promise<Response>>(async () =>
      res({
        employees: [
          { id: "emp-2", first_name: "Sam", last_name: "Lee", is_active: false },
        ],
      }),
    );
    const client = new RestHousecallProClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    const techs = await client.listTechnicians();
    expect(techs[0]).toEqual({ id: "emp-2", name: "Sam Lee", isActive: false });
  });

  it("tolerates missing fields and drops malformed rows (no throw)", async () => {
    const fetchMock = vi.fn<(url?: string, init?: RequestInit) => Promise<Response>>(async () =>
      res({
        employees: [
          { id: "emp-3" }, // no name, no active flag
          { name: "no id" }, // dropped: missing id
          null, // dropped: not an object
        ],
      }),
    );
    const client = new RestHousecallProClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    const techs = await client.listTechnicians();
    expect(techs).toHaveLength(1);
    expect(techs[0]).toEqual({ id: "emp-3", name: undefined, isActive: undefined });
  });

  it("returns an empty roster when the employees field is absent", async () => {
    const fetchMock = vi.fn<(url?: string, init?: RequestInit) => Promise<Response>>(async () => res({}));
    const client = new RestHousecallProClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    expect(await client.listTechnicians()).toEqual([]);
  });
});

describe("RestHousecallProClient — error handling + retry", () => {
  it("retries transient 429 then succeeds (backoff)", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchMock = vi.fn<(url?: string, init?: RequestInit) => Promise<Response>>(async () => {
      calls += 1;
      if (calls === 1) return res({}, false, 429);
      return res({ name: "Acme HVAC", id: "acct-1" });
    });
    const client = new RestHousecallProClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    const promise = client.getAccountInfo();
    await vi.runAllTimersAsync();
    const info = await promise;
    expect(info.companyName).toBe("Acme HVAC");
    expect(calls).toBe(2);
    vi.useRealTimers();
  });

  it("retries 5xx up to the limit then throws (status only, no key)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<(url?: string, init?: RequestInit) => Promise<Response>>(async () => res({}, false, 503));
    const client = new RestHousecallProClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    const promise = client.getJob("job-x");
    const assertion = expect(promise).rejects.toThrow(/HTTP 503/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("does NOT retry a non-retryable 400 (fails fast)", async () => {
    const fetchMock = vi.fn<(url?: string, init?: RequestInit) => Promise<Response>>(async () => res({}, false, 400));
    const client = new RestHousecallProClient(
      CONFIG,
      fetchMock as unknown as typeof fetch,
    );
    await expect(client.getJob("job-x")).rejects.toThrow(/HTTP 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// The getHousecallClient factory (and config resolution) are exercised in
// factory.test.ts / config.test.ts, which mock connection-queries at the top
// level — avoiding per-test vi.mock hoisting hazards. `getHousecallClient` is
// imported here only to keep the public surface referenced.
void getHousecallClient;
