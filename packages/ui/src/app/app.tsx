import { Rail } from "@/app/components/nav";
import { FrontDesk } from "@/app/screens/desk";
import { Library } from "@/app/screens/library";
import { Memory } from "@/app/screens/memory";
import { RecallInspector } from "@/app/screens/recall";
import { Review } from "@/app/screens/review";
import { Tags } from "@/app/screens/tags";
import { Timeline } from "@/app/screens/timeline";
import { useRoute } from "@/lib/router";

export function App() {
  const route = useRoute();

  return (
    <div className="bg-background text-foreground flex h-full overflow-hidden">
      <Rail current={route} />

      {/*
        relative: an absolutely positioned descendant takes main as its
        containing block, so it scrolls inside main instead of growing the
        document under the rail.
      */}
      <main className="relative min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl p-6 lg:p-8">
          {route.name === "library" ? <Library section={route.section} shelf={route.shelf} /> : null}
          {route.name === "memory" ? <Memory key={route.call} call={route.call} /> : null}
          {route.name === "timeline" ? <Timeline /> : null}
          {route.name === "tags" ? <Tags /> : null}
          {route.name === "review" ? <Review /> : null}
          {route.name === "recall" ? <RecallInspector /> : null}
          {route.name === "desk" ? <FrontDesk /> : null}
          {route.name === "unknown" ? (
            <div className="py-20 text-center">
              <h1 className="font-heading text-xl font-semibold">Nothing at {route.path}</h1>
              <p className="text-muted-foreground mt-1 text-sm">The rail on the left has everywhere there is to go.</p>
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}
