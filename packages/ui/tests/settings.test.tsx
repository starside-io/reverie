import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Rail } from "@/app/components/nav";
import { resetUpdatesForTest } from "@/app/components/updates";
import { Settings } from "@/app/screens/settings";
import { hrefOf, parseRoute } from "@/lib/router";

/**
 * The Settings screen and the rail line: the opt-in update check and the
 * desktop app, against a faked host. Nothing here reaches a real host,
 * GitHub or the claude CLI. Versions and paths are invented.
 */

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const INSTALLED = { pluginId: "reverie@reverie", marketplace: "reverie", version: "0.0.1", scope: "user", installPath: "/x" };
const LATEST = { version: "0.0.2", tag: "v0.0.2", url: "https://github.com/starside-io/reverie/releases/tag/v0.0.2", publishedAt: null };

function status(enabled: boolean, updateAvailable = enabled) {
  return {
    enabled,
    installed: INSTALLED,
    latest: enabled ? LATEST : null,
    updateAvailable,
    checkedAt: enabled ? new Date().toISOString() : null,
    error: null,
    command: "claude plugin marketplace update reverie && claude plugin update reverie@reverie",
  };
}

function fakeUpdatesHost(options: { enabled?: boolean; app?: Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  let enabled = options.enabled ?? false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (method === "POST" && (init?.headers as Record<string, string> | undefined)?.["content-type"] !== "application/json") {
        return json({ error: "Expected JSON" }, 415);
      }
      if (url === "/host/updates" && method === "GET") return json(status(enabled));
      if (url === "/host/updates/settings") {
        enabled = (body as { enabled: boolean }).enabled;
        return json(status(enabled));
      }
      if (url === "/host/updates/check") return json(status(enabled));
      if (url === "/host/updates/install") {
        return json({ ok: true, message: "Updated. Restart Claude Code to load the new version.", output: "", command: null });
      }
      if (url === "/host/app") {
        return json({ supported: true, path: "/Users/jane/Applications/Reverie.app", version: null, available: "0.0.1", ...options.app });
      }
      if (url === "/host/app/install") return json({ ok: true, message: "Reverie 0.0.1 is installed.", version: "0.0.1" });
      if (url === "/rpc") return json({ ok: true, tool: "memory.review", result: { state: "pending", proposals: [], groups: [] } });
      return json({ error: `No fake for ${url}` }, 404);
    }),
  );
  return calls;
}

beforeEach(() => {
  resetUpdatesForTest();
});

describe("the settings route", () => {
  it("is /settings", () => {
    expect(parseRoute("/settings")).toEqual({ name: "settings" });
    expect(hrefOf({ name: "settings" })).toBe("/settings");
  });
});

describe("the Settings screen", () => {
  it("starts with the check off, says what is installed, and asks GitHub nothing", async () => {
    const calls = fakeUpdatesHost();
    render(<Settings />);

    const box = (await screen.findByLabelText("Check for plugin updates")) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    expect(box.checked).toBe(false);
    expect(screen.getByText("Version 0.0.1 of the plugin is installed.")).toBeTruthy();
    expect(screen.queryByText("Check now")).toBeNull();
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("turns the check on with a JSON post, then offers the newer release with a plain button", async () => {
    const calls = fakeUpdatesHost();
    render(<Settings />);

    const box = (await screen.findByLabelText("Check for plugin updates")) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    fireEvent.click(box);

    await screen.findByText("Version 0.0.2 is out. You have 0.0.1.");
    expect(calls.find((call) => call.url === "/host/updates/settings")).toMatchObject({ method: "POST", body: { enabled: true } });
    expect(screen.getByText("What changed").getAttribute("href")).toBe(LATEST.url);

    fireEvent.click(screen.getByRole("button", { name: "Install 0.0.2" }));
    await screen.findByText("Updated. Restart Claude Code to load the new version.");
    expect(calls.filter((call) => call.url === "/host/updates/install")).toHaveLength(1);
  });

  it("checks now through POST /host/updates/check", async () => {
    const calls = fakeUpdatesHost({ enabled: true });
    render(<Settings />);
    fireEvent.click(await screen.findByRole("button", { name: /Check now/ }));
    await waitFor(() => expect(calls.some((call) => call.url === "/host/updates/check" && call.method === "POST")).toBe(true));
  });

  it("offers the desktop app when it is not installed, and installs it on a press", async () => {
    const calls = fakeUpdatesHost();
    render(<Settings />);

    fireEvent.click(await screen.findByRole("button", { name: "Install the app (0.0.1)" }));
    await screen.findByText("Reverie 0.0.1 is installed.");
    expect(calls.filter((call) => call.url === "/host/app/install")).toHaveLength(1);
  });

  it("says plainly that the app is Apple Silicon only, with no button", async () => {
    fakeUpdatesHost({ app: { supported: false } });
    render(<Settings />);
    await screen.findByText(/built for Apple Silicon Macs only/);
    expect(screen.queryByRole("button", { name: /Install the app/ })).toBeNull();
  });
});

describe("the rail", () => {
  it("links to Settings, and shows one plain line with a button while an update is out", async () => {
    fakeUpdatesHost({ enabled: true });
    render(<Rail current={{ name: "library", section: null, shelf: null }} />);

    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/settings");
    await screen.findByText("Version 0.0.2 is out. You have 0.0.1.");
    expect(screen.getByRole("button", { name: "Install 0.0.2" })).toBeTruthy();
  });

  it("says nothing about updates while the check is off", async () => {
    const calls = fakeUpdatesHost();
    render(<Rail current={{ name: "settings" }} />);
    await waitFor(() => expect(calls.some((call) => call.url === "/host/updates")).toBe(true));
    expect(screen.queryByText(/is out/)).toBeNull();
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("aria-current")).toBe("page");
  });
});
