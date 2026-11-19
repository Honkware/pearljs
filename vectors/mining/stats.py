"""Luck intervals from SciPy, for pearljs's luck and gammaQuantile.

The exact Poisson (Garwood) interval for `found` events over `expected`:
chi2.ppf(a/2, 2 found) / 2 and chi2.ppf(1 - a/2, 2 found + 2) / 2, each over
expected. Nothing here comes from Pearl, which has no pool statistics.

    python3 vectors/mining/stats.py > vectors/mining/stats.json
"""

import json

import scipy
from scipy.stats import chi2, gamma

luck = []
for found in [0, 1, 2, 5, 10, 50, 200, 1000]:
    for expected in [1.0, 3.7, 100.0]:
        for confidence in [0.9, 0.95, 0.99]:
            a = 1 - confidence
            low = 0.0 if found == 0 else chi2.ppf(a / 2, 2 * found) / 2 / expected
            high = chi2.ppf(1 - a / 2, 2 * found + 2) / 2 / expected
            luck.append({"found": found, "expected": expected, "confidence": confidence, "luck": found / expected, "low": low, "high": high})

quantiles = [{"p": p, "shape": s, "x": gamma.ppf(p, s)} for p in [0.001, 0.025, 0.5, 0.975, 0.999] for s in [0.5, 1, 2.5, 10, 1001]]
print(json.dumps({"source": f"scipy {scipy.__version__}", "luck": luck, "gammaQuantiles": quantiles}, indent=1))
