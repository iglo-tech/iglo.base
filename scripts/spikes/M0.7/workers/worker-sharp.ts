// M0.7 spike: the Worker entry of the "sharp" candidate, compiled into bench.ts.

import { createThumb } from "@/../scripts/spikes/M0.7/candidates/sharp";
import { serve } from "@/../scripts/spikes/M0.7/workers/serve";

serve(createThumb);
