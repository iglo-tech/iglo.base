// M0.7 spike: a Worker entry with no image code, the size baseline.

import { serve } from "@/../scripts/spikes/M0.7/workers/serve";

serve(async () => {
  throw new Error("no candidate");
});
