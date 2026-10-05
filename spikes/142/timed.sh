#!/usr/bin/env bash
# Spike #142: runs a command and prints how long it took, in seconds (BSD date has no %N).
#
#   spikes/142/timed.sh <label> <command…>
set -euo pipefail
label=$1
shift
start=$(python3 -c "import time; print(time.time())")
"$@"
python3 -c "import time; print('$label: %.2f s' % (time.time() - $start))"
