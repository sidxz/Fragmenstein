#!/bin/bash
set -e

# Install PyRosetta at startup if INSTALL_PYROSETTA=true
# This avoids baking license-dependent software into the image.
# PyRosetta is cached in /app/pyrosetta_cache so it survives container restarts
# when the cache dir is mounted as a volume.
if [ "$INSTALL_PYROSETTA" = "true" ]; then
    CACHE_DIR="/app/data/.pyrosetta_cache"
    MARKER="$CACHE_DIR/.installed"

    if [ -f "$MARKER" ]; then
        echo "PyRosetta already installed (cached), skipping download."
        export PYTHONPATH="$CACHE_DIR:$PYTHONPATH"
    else
        echo "Installing PyRosetta via pyrosetta-installer..."
        # mirror=1 is graylab.jhu.edu (east); mirror=0 (west.rosettacommons.org) currently
        # returns 404 for the wheel its own latest.html points at.
        python -c "import pyrosetta_installer; pyrosetta_installer.install_pyrosetta(mirror=1)"
        echo "PyRosetta installed successfully."
    fi
fi

exec gosu appuser "$@"
