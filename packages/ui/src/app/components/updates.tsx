import { useEffect, useState, useSyncExternalStore } from "react";
import { RefreshCw } from "lucide-react";

import { updates, type DesktopAppStatus, type InstallResult, type UpdateStatus } from "@/client";
import { SectionCard } from "@/ds/section-card";
import { Button } from "@/ui/button";
import { Label } from "@/ui/label";

/**
 * The plugin update check: one line in the rail when a newer release is out,
 * and the switch for it on the Settings screen. Lifted from Fellowship's
 * updates.tsx, the one status line version. Both read one shared state, so
 * turning the check on in Settings shows the rail line without a reload, and
 * an install started from either place shows in both.
 *
 * The check is off until the owner turns it on, and while it is off the host
 * makes no request at all. Plain text and a button: no chip, no dot.
 */

interface UpdatesState {
  status: UpdateStatus | null;
  installing: boolean;
  result: InstallResult | null;
  checking: boolean;
}

let state: UpdatesState = { status: null, installing: false, result: null, checking: false };
let loaded = false;
const listeners = new Set<() => void>();

function set(patch: Partial<UpdatesState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function load(refresh = false) {
  set({ checking: true });
  try {
    set({ status: refresh ? await updates.check() : await updates.status() });
  } catch {
    // A host that does not answer has nothing to offer.
  } finally {
    set({ checking: false });
  }
}

async function toggle(enabled: boolean) {
  set({ checking: true });
  try {
    set({ status: await updates.setEnabled(enabled), result: null });
  } catch {
    // The switch stays where the host last said it was.
  } finally {
    set({ checking: false });
  }
}

async function install() {
  if (state.installing) return;
  set({ installing: true, result: null });
  let result: InstallResult;
  try {
    result = await updates.install();
  } catch (error) {
    result = {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      output: "",
      command: state.status?.command ?? null,
    };
  }
  set({ installing: false, result });
  if (result.ok) await load();
}

function useUpdates(): UpdatesState {
  const current = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    if (loaded) return;
    loaded = true;
    void load();
  }, []);
  return current;
}

/** For a test: forget what was loaded, so the next render asks the host again. */
export function resetUpdatesForTest(): void {
  state = { status: null, installing: false, result: null, checking: false };
  loaded = false;
}

/** In the rail, only while there is something to say. */
export function UpdateLine() {
  const { status, installing, result } = useUpdates();

  if (result?.ok) {
    return <p className="text-positive px-1 text-xs">Reverie is updated. Restart Claude Code to load it.</p>;
  }
  if (!status?.updateAvailable && !installing) return null;

  return (
    <div className="space-y-1.5 px-1">
      <p className="text-sidebar-foreground text-xs">
        {installing
          ? "Installing the update. This can take a few minutes."
          : `Version ${status?.latest?.version ?? "?"} is out. You have ${status?.installed?.version ?? "?"}.`}
      </p>
      {installing ? null : (
        <Button size="xs" variant="outline" onClick={() => void install()}>
          Install {status?.latest?.version}
        </Button>
      )}
      {result && !result.ok ? <p className="text-negative text-xs">{result.message}</p> : null}
    </div>
  );
}

/** "just now", "12 minutes ago", "yesterday": when the last answer came in. */
function ago(iso: string | null): string | null {
  if (!iso) return null;
  const seconds = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (Math.abs(seconds) < 60) return "just now";
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
}

/** One sentence for where things stand, instead of a table of three facts. */
function summary(status: UpdateStatus): string {
  const installed = status.installed;
  if (!installed) return "Reverie is not installed as a Claude Code plugin here, so there is nothing to update.";
  if (!status.enabled) return `Version ${installed.version} of the plugin is installed.`;

  const checked = ago(status.checkedAt);
  const when = checked ? ` Checked ${checked}.` : "";
  if (status.updateAvailable && status.latest) {
    return `Version ${status.latest.version} is out. You have ${installed.version}.`;
  }
  if (!status.latest) return `Version ${installed.version} is installed. No release is published yet.${when}`;
  return `Version ${installed.version} is the latest.${when}`;
}

/** On the Settings screen: the switch, and one line on where things stand. */
export function UpdatesCard() {
  const { status, installing, result, checking } = useUpdates();
  const canCheck = Boolean(status?.enabled && status.installed);

  return (
    <SectionCard
      title="Updates"
      description="Off until you turn it on. Once a day the host asks GitHub for the newest release of the plugin. That request is all that is sent: no memory, no count, no path."
    >
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <input
            id="update-check"
            type="checkbox"
            className="accent-primary size-4"
            checked={status?.enabled ?? false}
            disabled={status === null || checking}
            onChange={(event) => void toggle(event.currentTarget.checked)}
          />
          <Label htmlFor="update-check" className="flex-1">
            Check for plugin updates
          </Label>
          {canCheck ? (
            <Button size="sm" variant="ghost" disabled={checking || installing} onClick={() => void load(true)}>
              <RefreshCw className={checking ? "animate-spin" : undefined} aria-hidden />
              {checking ? "Checking" : "Check now"}
            </Button>
          ) : null}
        </div>

        {status ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pl-6">
            <p className="text-muted-foreground text-sm">
              {summary(status)}
              {status.updateAvailable && status.latest ? (
                <>
                  {" "}
                  <a
                    href={status.latest.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-foreground underline underline-offset-2"
                  >
                    What changed
                  </a>
                </>
              ) : null}
            </p>
            {status.updateAvailable && status.latest ? (
              <Button size="sm" disabled={installing} onClick={() => void install()}>
                {installing ? "Installing" : `Install ${status.latest.version}`}
              </Button>
            ) : null}
          </div>
        ) : null}

        {status?.error ? <p className="text-negative pl-6 text-sm">{status.error}</p> : null}
        {result ? (
          <p className={`pl-6 text-sm ${result.ok ? "text-positive" : "text-negative"}`}>{result.message}</p>
        ) : null}
        {result && !result.ok && result.output ? (
          <pre className="bg-muted ml-6 max-h-48 overflow-auto rounded-md p-2 text-xs whitespace-pre-wrap">
            {result.output}
          </pre>
        ) : null}
      </div>
    </SectionCard>
  );
}

/**
 * Reverie.app: installed on request from the release, and kept in step by
 * the plugin update above. On a Mac it does not run on, it says so.
 */
export function DesktopAppCard() {
  const [app, setApp] = useState<DesktopAppStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void updates
      .app()
      .then(setApp)
      .catch(() => setApp(null));
  }, []);

  async function installApp() {
    setInstalling(true);
    setMessage(null);
    const answer = await updates
      .installApp()
      .catch((error: unknown) => ({ ok: false, message: String(error), version: null }));
    setMessage({ ok: answer.ok, text: answer.message });
    setInstalling(false);
    void updates
      .app()
      .then(setApp)
      .catch(() => undefined);
  }

  const behind = app !== null && app.version !== null && app.version !== app.available;

  return (
    <SectionCard
      title="Desktop app"
      description="Reverie.app opens the library in its own window, without a browser. It is downloaded from the GitHub release only when you press the button, checked against its published SHA-256."
    >
      {app === null ? (
        <p className="text-muted-foreground text-sm">The host did not say where the app is.</p>
      ) : !app.supported ? (
        <p className="text-muted-foreground text-sm">
          The desktop app is built for Apple Silicon Macs only. The library works in this browser either way.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="text-muted-foreground text-sm">
            {app.version
              ? `Reverie.app ${app.version} is in ${app.path.replace(/\/Reverie\.app$/, "")}.`
              : "The desktop app is not installed."}
          </p>
          {app.version === null || behind ? (
            <Button size="sm" variant="outline" disabled={installing} onClick={() => void installApp()}>
              {installing
                ? "Downloading"
                : app.version === null
                  ? `Install the app (${app.available})`
                  : `Update the app to ${app.available}`}
            </Button>
          ) : null}
          {message ? (
            <p className={message.ok ? "text-positive text-sm" : "text-negative text-sm"}>{message.text}</p>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}
