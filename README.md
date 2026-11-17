# GTA VI Launch-Day Twitch CCU Forecast

[![make.fun](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/competitions/gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/chepster4/gta6-twitch-ccu-forecast-01/rank.svg)](https://make.fun/competitions/gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/chepster4/gta6-twitch-ccu-forecast-01/reward.svg)](https://make.fun/competitions/gta6-twitch-ccu-forecast-01)

Forecast GTA VI's launch-day Twitch concurrent viewers, hour by hour
(hours 2–24), as 5 quantiles (5%, 25%, 50%, 75%, 95%) per hour.

## Method

Anchored on the observed hour-1 viewers (`p1`) and the pre-release hype
ratio (`r01 = p1 / median` of the 6 hourly points before launch). A pool of
37 comparable big-game launches (the one non-launch category entry is
filtered out) supplies each game's full launch-day curve as log-ratios
relative to its own hour 1. For every forecast hour, a Gaussian-kernel
weighted local-linear regression of those log-ratios on log hour-1 viewers
(with a second kernel on log `r01`) predicts the centre of the log-ratio;
the weighted residual spread, floored and shrunk, sets the interval width.
Centres and spreads are smoothed across neighbouring hours (triangular
±1), then turned into quantiles with normal z-scores around `p1`.

## Run

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

Reads every `*.in` in the input dir, writes one `*.out` per case.
TypeScript, Node 22, stdlib only (`fs`, `path`) — no network, no
dependencies, fully deterministic (two runs are byte-identical).

## License

MIT — see [LICENSE](LICENSE).
