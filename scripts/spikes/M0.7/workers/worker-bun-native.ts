// M0.7 spike: the Worker entry of the "bun-native" candidate, compiled into bench.ts.

import { createThumb } from "@/../scripts/spikes/M0.7/candidates/bun-native";
import { serve } from "@/../scripts/spikes/M0.7/workers/serve";

serve(createThumb);
