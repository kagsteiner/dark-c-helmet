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

## Results, 1600 band

### net_h1600_v1 (2026-10-31)

Trained 2 epochs on 369M positions (Lichess 2024-01, 1500-1700, 5.6M games); validation on
2017-01: policy move match 43.1%. `calibrate.py --profile 1600`, 2000 positions, seed 1:

| Moves of | move match | avg loss | blunders (>= 200 cp) |
|---|---|---|---|
| real 1600 players | - | 110 cp | 14.7% |
| line search, profile 1600 | 44.0% | 118 cp | 15.8% |
| plain policy move | 44.8% | 160 cp | 21.6% |

Blind=25 Replies=2 (115 cp, 42.7%) and Blind=8 Budget=200 LineDepth=5 (116 cp, 41.8%) were
within noise but less human; the profile is kept as it is.

## Chess960, 1300 band

### net_h1300-960_v1 (2026-11-01)

The 1300 net, trained on for 3 epochs (lr 3e-4) on 12.5M positions of Chess960 games plus as
many standard positions (Lichess Chess960 2021-10..2026-09 without 2024-01, both players'
960 ratings 1200-1400; data in `~/VibeEngineData/lichess-960-1200-1400/`, `fetch.sh`). The
converter starts a game from its `[FEN]` header; `human-train --init net.hnet` continues
training a net. The engine uses a band's `-960` net and profile when UCI_Chess960 is on.

Validation: Chess960 games of 2024-01 (3,256 games), move match of the plain policy:

| net | all | first 10 moves each | later | standard (2017-01) |
|---|---|---|---|---|
| h1300_v1 | 28.6% | 19.0% | 34.1% | 42.0% |
| 960 games only, lr 3e-4 | 35.4% | 32.6% | 37.0% | 40.1% |
| 960 games only, lr 1e-4 | 34.9% | 31.9% | 36.6% | 40.5% |
| **960 + standard, lr 3e-4 (v1)** | 35.3% | 32.3% | 37.1% | 41.6% |

`calibrate.py --chess960`, 2000 positions: with h1300_v1 and profile 1300 the player lost
170 cp per move (real players 146). With h1300-960_v1 it still lost 163, so the profile
"1300-960" overlooks fewer replies (Blind 15 instead of 25; 10-15 measured within noise):
156 cp, 21.3% blunders, 36.6% move match; real 1300 players in the same run 154 cp, 20.7%.

## Chess960, 1600 band

### net_h1600-960_v1 (2026-11-02)

Same procedure as for 1300: the 1600 net trained on for 3 epochs (lr 3e-4) on 58.2M positions of
Chess960 games plus as many standard positions (Lichess Chess960 2021-10..2026-09 without
2024-01, 954k games, both players' 960 ratings 1500-1700; games with a player at exactly 1500,
the starting rating, left out). Data in `~/VibeEngineData/lichess-960-1500-1700/`.

| net (validation: Chess960 2024-01, 14,254 games) | all | first 10 moves each | later | standard (2017-01) |
|---|---|---|---|---|
| h1600_v1 | 30.3% | 21.4% | 34.6% | 43.1% |
| h1600-960_v1 | 37.5% | 36.6% | 38.0% | 42.7% |

`calibrate.py --chess960 --profile 1600`, 2000 positions (real 1600 players: 108-117 cp per
run, about 15% blunders):

| | move match | avg loss | blunders |
|---|---|---|---|
| h1600_v1, profile 1600 | 32.5% | 137 cp | 18.1% |
| h1600-960_v1, profile 1600 | 33.8% | 132 cp | 17.8% |
| h1600-960_v1, Temperature 25 (profile "1600-960") | 35.0% | 129 cp | 17.1% |

Blind 5/8, Replies 4, Optimism 5, Satisfied 80, more candidates and deeper lines (up to
Replies 5, LineDepth 6, Budget 600) all stayed at 128-138 cp: in Chess960 the 1600 player
still plays somewhat below a real 1600. The remaining gap is the net's.

**Tried (2026-11-02), not shipped: h1600-960_v2**, trained the same way on Chess960 games one band
higher (1600-1800, 1.0M games, 63.5M positions) to make the player stronger. Move match 37.5%
(as v1), but 133 cp instead of 129: no stronger. Split by game phase (h1600-960_v1, profile 1600-960):

| | real 1600 players | 1600 player |
|---|---|---|
| Chess960, first 10 moves each | 35 cp, 2.5% blunders | 34 cp, 2.8% |
| Chess960, later | 133 cp, 18.4% | 167 cp, 23.5% |
| standard, all moves | 106 cp, 13.7% | 112 cp, 15.7% |

The opening is fine; the gap is blunders in Chess960 middlegames, which the line search
overlooks more often than real players do (not something the net lacks).
