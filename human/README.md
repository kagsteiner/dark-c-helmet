# Human-like player

A separate engine that plays like a person of a rating band, not like a weakened engine.
It shares only the board code of `src/` (position, move generation); the main engine's
search, NNUE and build are untouched. In the web app it is the opponent "Human-like 1300".

## How it plays

- **The net** (`hnet.h`) is trained on real games of the band (Lichess, CC0). Its policy head
  says which moves come to mind (and so which are overlooked); its value head says how
  players of the band would score from a position.
- **The search** (`hsearch.c`) thinks in lines, not trees: a few candidate moves (the
  policy's favourites, in a slightly random order); for each, the opponent's most obvious
  reply and maybe one more, followed as a single line of likely moves; the worst checked
  reply counts, softened by optimism. Backward moves and long quiet slides of the opponent
  are sometimes overlooked. The first line that looks clearly good is played.
- **The clock**: it uses the time a move deserves (the main engine's budget, +-25%), the
  web app waits on its behalf.

A profile (`HPROFILES` in `hsearch.c`) sets all of this per band; every field is also a
UCI option, so profiles can be tuned without rebuilding.

## Files

| File | |
|---|---|
| `hnet.h` | network layout, position encoding, training-sample format |
| `convert.c` | PGN -> samples (`bin/human-convert`) |
| `train.c` | trainer, Accelerate (`bin/human-train`) |
| `embed.py` | nets -> `hnet_data.c` (16-bit floats, one net per band) |
| `hnet.c`, `hsearch.c`, `huci.c` | the engine (`bin/humanplayer`, `dh-human.wasm`) |
| `calibrate.py` | move match and centipawn loss against real games of the band |

## Building a band (1300 done; 1600 and 1900 the same way)

Data lives outside OneDrive, one folder per band, e.g. `~/VibeEngineData/lichess-human-games-1200-1400/`
(README and `filter.py` there). For 1600: copy `filter.py` with the bounds 1500-1700, then

```bash
make human-tools
curl -s https://database.lichess.org/standard/lichess_db_standard_rated_2024-01.pgn.zst | zstdcat \
  | python3 -I filter.py | zstd -q -o human_1500-1700_2024-01.pgn.zst
zstdcat human_1500-1700_2024-01.pgn.zst | bin/human-convert train_2024-01.bin
zstdcat human_1500-1700_2017-01.pgn.zst | bin/human-convert val_2017-01.bin     # games from another month
bin/human-train train_2024-01.bin val_2017-01.bin net_h1600_v1.hnet --epochs 2
python3 human/embed.py net_h1300_v1.hnet net_h1600_v1.hnet                       # all bands' nets
```

Then add a line for "1600" to `HPROFILES` (a stronger player: more candidates and replies,
deeper lines, less optimism and blindness, bigger budget), `make human`, and tune with
`calibrate.py --profile 1600 --set Name=value` until its loss matches the 1600 humans'.
In the web app add `["human-1600", "Human-like 1600"]` to the opponent choice in
`webapp/src/play/new-game.ts`; `npm run engine` rebuilds `dh-human.wasm`.

The net file name sets the band: `net_h1600_v1.hnet` serves the profile "1600".

## Results, 1300 band

See the end of this file (updated after each training/tuning round).

### net_h1300_v1 (2026-10-31)

Trained 2 epochs on 270M positions (Lichess 2024-01, 1200-1400); validation on 2017-01 games:
policy move match 42.0%. `calibrate.py`, 2000 positions, seed 1, judged at 100k nodes:

| Moves of | move match | avg loss | blunders (>= 200 cp) |
|---|---|---|---|
| real 1300 players | - | 140 cp | 19.4% |
| line search, profile 1300 | 40.6% | 172 cp | 23.0% |
| plain policy move | 44.0% | 200 cp | 25.7% |

More replies, more blindness/optimism, more candidates or deeper lines did not get closer
(176-180 cp); the remaining gap is the net's. The profile plays somewhat below a real 1300.

**Correction (same day):** the profile line above was written in the wrong field order
(budget 0, material 60), so the search stopped after its first candidate. Fixed with named
fields; the corrected profile 1300 measures 146 cp avg loss, 18.9% blunders, 41.6% move match
(real 1300 players in the same run: 144 cp, 20.4%) - now a close match.
