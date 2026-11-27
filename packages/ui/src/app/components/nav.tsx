import { BookOpen, CalendarRange, ConciergeBell, Inbox, Search, Settings, Tags } from "lucide-react";

import { HourglassMark } from "@/app/components/logo";
import { UpdateLine } from "@/app/components/updates";
import { ThemeToggle } from "@/app/theme";
import { cn } from "@/lib/cn";
import { hrefOf, useLinkHandler, type Route } from "@/lib/router";
import { useRpc } from "@/lib/use-rpc";
import type { ReviewResult } from "@/types";

/**
 * The side rail: the screens, with the review count as a plain number beside
 * its link. No chip, no dot: a number is enough. At the foot, above the
 * Settings link, one line when a plugin update is out (UpdateLine), where
 * Fellowship puts its update button.
 */

const LINKS: Array<{ route: Route; label: string; icon: typeof BookOpen }> = [
  { route: { name: "library", section: null, shelf: null }, label: "Library", icon: BookOpen },
  { route: { name: "timeline" }, label: "Timeline", icon: CalendarRange },
  { route: { name: "tags" }, label: "Tags", icon: Tags },
  { route: { name: "review" }, label: "Review", icon: Inbox },
  { route: { name: "recall" }, label: "Recall inspector", icon: Search },
  { route: { name: "desk" }, label: "Front desk", icon: ConciergeBell },
];

const SETTINGS: Route = { name: "settings" };

export function Rail({ current }: { current: Route }) {
  const onLink = useLinkHandler();
  const review = useRpc<ReviewResult>("memory.review", { state: "pending" });
  const waiting = review.data?.proposals.length ?? 0;

  return (
    <nav aria-label="Screens" className="bg-sidebar border-sidebar-border flex w-56 shrink-0 flex-col border-r">
      <a href="/" onClick={onLink} className="text-sidebar-foreground flex items-center gap-2 px-4 py-4">
        <HourglassMark className="size-7 shrink-0" />
        <span className="font-heading text-base font-semibold tracking-tight">Reverie</span>
      </a>

      <ul className="space-y-0.5 px-2">
        {LINKS.map((link) => {
          const active =
            current.name === link.route.name || (link.route.name === "library" && current.name === "memory");
          return (
            <li key={link.label}>
              <a
                href={hrefOf(link.route)}
                onClick={onLink}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    : "text-muted-foreground hover:bg-sidebar-accent/60",
                )}
              >
                <link.icon className="size-4" aria-hidden />
                <span className="flex-1">{link.label}</span>
                {link.route.name === "review" && waiting > 0 ? (
                  <span className="text-muted-foreground tabular-nums" aria-label={`${waiting} waiting`}>
                    {waiting}
                  </span>
                ) : null}
              </a>
            </li>
          );
        })}
      </ul>

      <div className="mt-auto space-y-2 px-2 pt-3">
        <UpdateLine />
        <a
          href={hrefOf(SETTINGS)}
          onClick={onLink}
          aria-current={current.name === "settings" ? "page" : undefined}
          className={cn(
            "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm",
            current.name === "settings"
              ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
              : "text-muted-foreground hover:bg-sidebar-accent/60",
          )}
        >
          <Settings className="size-4" aria-hidden />
          <span className="flex-1">Settings</span>
        </a>
      </div>

      <div className="flex items-center justify-between p-3 px-4">
        <span className="text-muted-foreground text-xs">Local only, 127.0.0.1</span>
        <ThemeToggle />
      </div>
    </nav>
  );
}
