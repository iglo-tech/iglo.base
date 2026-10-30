// M0.7 spike: the Worker entry of the "bun-hybrid2" candidate, compiled into bench.ts.

import { createThumbWithMargin } from "@/../scripts/spikes/M0.7/candidates/bun-hybrid";
import { serve } from "@/../scripts/spikes/M0.7/workers/serve";

serve(createThumbWithMargin(2));
