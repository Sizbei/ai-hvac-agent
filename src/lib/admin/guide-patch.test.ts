import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { patchGuide } from "./guide-patch";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", { location: { href: "" } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("patchGuide (the one guide PATCH, final wave L5)", () => {
  it("PATCHes /api/admin/guide with the JSON body and resolves true on ok", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await expect(patchGuide({ tourCompleted: true })).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin/guide");
    expect(init).toMatchObject({ method: "PATCH", headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(init.body)).toEqual({ tourCompleted: true });
  });

  it("resolves false on a non-ok response", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 500 }));
    await expect(patchGuide({ lesson: "requests" })).resolves.toBe(false);
  });

  it("resolves false when the network fails, never rejecting", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    await expect(patchGuide({ lesson: "requests" })).resolves.toBe(false);
  });

  it("resolves false on a 401 (adminFetch sends the browser to sign in)", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 401 }));
    await expect(patchGuide({ lesson: "requests" })).resolves.toBe(false);
    expect((window as unknown as { location: { href: string } }).location.href).toBe("/admin/login");
  });

  it("logs nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue(new Response("{}", { status: 500 }));
    await patchGuide({ lesson: "requests" });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
