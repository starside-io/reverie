import { PageHeader } from "@/app/components/page-header";
import { DesktopAppCard, UpdatesCard } from "@/app/components/updates";

/**
 * Settings: the opt-in plugin update check and the desktop app, nothing
 * else. Both are the host's (/host/updates, /host/app), not the module's.
 * The library's own config is still set through POST /host/config.
 */
export function Settings() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Everything here is local. Nothing in this app reaches the network by itself, apart from the update check below once you turn it on, and the desktop app download when you ask for it."
      />
      <UpdatesCard />
      <DesktopAppCard />
    </div>
  );
}
