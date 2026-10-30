// M0.7 spike: the Worker entry of the "jsquash" candidate, compiled into bench.ts.

import { createThumb } from "@/../scripts/spikes/M0.7/candidates/jsquash";
import { serve } from "@/../scripts/spikes/M0.7/workers/serve";

serve(createThumb);
