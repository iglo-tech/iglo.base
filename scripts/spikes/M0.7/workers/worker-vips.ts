// M0.7 spike: the Worker entry of the "vips" candidate, compiled into bench.ts.

import { createThumb } from "@/../scripts/spikes/M0.7/candidates/vips";
import { serve } from "@/../scripts/spikes/M0.7/workers/serve";

serve(createThumb);
